import { Groq } from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { resumeText, jobDescription } = req.body;
        
        if (!resumeText) {
            return res.status(400).json({ error: 'Missing resume context data profile.' });
        }

        const isTealMode = jobDescription && jobDescription.length > 50;

        // LAYER 1: TIMELINE PARSING & REQUIREMENT TRIAGE (The LLM Brain)
        const systemPrompt = `You are a ruthless, top-tier FAANG Technical Recruiter and Data Extractor. 
        
        TASK 1 (REQUIREMENTS): Extract exactly 10 to 12 skills from the Job Description into three strict tiers:
        - "dealbreaker": Absolute mandatory requirements (e.g., specific clearances, required degrees, core languages).
        - "critical": Core skills necessary for the job.
        - "bonus": Nice-to-have skills.
        For each, provide an array of 2-3 common synonyms (e.g., "Kubernetes", "K8s").
        
        TASK 2 (CANDIDATE TIMELINE): Parse the candidate's work experience into a chronological structure. Extract the job title, a boolean indicating if it is their current/most recent job, and an array of their exact bullet points.
        
        TASK 3 (CRITIQUE): Provide a brutal, section-by-section critique calling out weak bullet points, missing quantifiable metrics, and poor phrasing.
        
        ${isTealMode ? `TARGET JOB DESCRIPTION:\n${jobDescription}\n\n` : 'If no JD is provided, extract 10 standard industry skills based on the candidate\\'s resume as "critical".\n\n'}
        
        CRITICAL: Return ONLY valid JSON matching this schema:
        {
            "requirements": [
                { "skill": "Python", "tier": "critical", "synonyms": ["Python 3", "Python3"] }
            ],
            "experienceTimeline": [
                { "title": "Software Engineer", "isCurrent": true, "bullets": ["Led migration to AWS...", "Fixed bugs."] }
            ],
            "sectionCritiques": ["Experience: Bullet 2 lacks metrics. 'Fixed bugs' means nothing."]
        }`;

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `CANDIDATE RESUME TEXT:\n\n${resumeText}` }
            ],
            temperature: 0.0, // Hard zero for deterministic structuring
            response_format: { type: "json_object" }
        });

        const parsedData = JSON.parse(completion.choices[0].message.content.trim());
        
        // Safety Fallbacks
        const requirements = Array.isArray(parsedData.requirements) ? parsedData.requirements : [];
        const timeline = Array.isArray(parsedData.experienceTimeline) ? parsedData.experienceTimeline : [];
        const critiquesArray = Array.isArray(parsedData.sectionCritiques) ? parsedData.sectionCritiques : ["Formatting optimization advised."];

        // LAYER 2: EVIDENCE DENSITY HEURISTICS
        let totalBullets = 0;
        let strongBullets = 0;
        const strongVerbRegex = /^(architected|led|drove|spearheaded|engineered|developed|built|designed|launched|managed|scaled|optimized|increased|decreased|reduced)\b/i;
        
        timeline.forEach(role => {
            if (Array.isArray(role.bullets)) {
                role.bullets.forEach(bullet => {
                    totalBullets++;
                    // A strong bullet has numbers (metrics) or starts with an ownership verb
                    const hasMetrics = /\d/.test(bullet) || /[%$]/.test(bullet);
                    const hasOwnership = strongVerbRegex.test(bullet.trim());
                    if (hasMetrics || hasOwnership) {
                        strongBullets++;
                    }
                });
            }
        });
        
        // Evidence multiplier (0.0 to 1.0). If no bullets, default to 0.5 to prevent harsh 0s.
        const evidenceRatio = totalBullets > 0 ? (strongBullets / totalBullets) : 0.5;


        // LAYER 3: SEMANTIC REGEX WITH RECENCY WEIGHTING
        const missing = [];
        let maxPossiblePoints = 0;
        let earnedPoints = 0;
        let dealbreakersMissed = 0;
        let criticalMissed = 0;

        requirements.forEach(req => {
            const isDealbreaker = req.tier === 'dealbreaker';
            const isCritical = req.tier === 'critical';
            
            // Dealbreakers are gates, not points. Critical = 10, Bonus = 3.
            const weight = isDealbreaker ? 0 : (isCritical ? 10 : 3);
            maxPossiblePoints += weight;

            const searchTerms = [req.skill, ...(req.synonyms || [])].map(term => 
                term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') 
            );
            const regexPattern = new RegExp(`\\b(${searchTerms.join('|')})\\b`, 'i');

            let found = false;
            let recencyMultiplier = 0;

            // Search the timeline to weigh recency
            for (const role of timeline) {
                const roleText = `${role.title} ${Array.isArray(role.bullets) ? role.bullets.join(' ') : ''}`;
                if (regexPattern.test(roleText)) {
                    found = true;
                    // Current roles get 100% credit. Older roles decay to 60% credit.
                    recencyMultiplier = role.isCurrent ? 1.0 : 0.6;
                    break; 
                }
            }

            // Fallback: If not in a specific role, check the raw text (e.g., a "Skills" list at the bottom).
            // Skills dumped in a list without context only get 40% credit.
            if (!found && regexPattern.test(resumeText)) {
                found = true;
                recencyMultiplier = 0.4;
            }

            if (found) {
                earnedPoints += (weight * recencyMultiplier);
            } else {
                missing.push(req.skill);
                if (isDealbreaker) dealbreakersMissed++;
                if (isCritical) criticalMissed++;
            }
        });

        // LAYER 4: THE CORPORATE REALITY GUILLOTINE (Math)
        let calculatedScore = 0;
        if (maxPossiblePoints > 0) {
            // Keywords make up 75% of the score. Evidence Density makes up 25%.
            const keywordScore = (earnedPoints / maxPossiblePoints) * 75;
            const evidenceScore = evidenceRatio * 25;
            
            calculatedScore = Math.round(keywordScore + evidenceScore);
            
            // The Guillotines
            if (dealbreakersMissed > 0) {
                // Miss a dealbreaker? Auto-reject ceiling.
                calculatedScore = Math.min(calculatedScore, 20);
                critiquesArray.unshift(`🚨 DEALBREAKER MISSING: You are missing critical gating requirements (${missing.slice(0,2).join(', ')}). This resume would be auto-rejected.`);
            } else if (criticalMissed > 0) {
                // Miss a core requirement? Hard cap at 75.
                calculatedScore = Math.min(calculatedScore, 75);
            }
            
            // Hard floors and ceilings
            if (calculatedScore < 15) calculatedScore = 15;
            if (calculatedScore > 100) calculatedScore = 100;
        }

        // Return the payload exactly as the frontend expects it
        return res.status(200).json({
            score: calculatedScore,
            sectionCritiques: critiquesArray,
            missingKeywords: missing
        });

    } catch (error) {
        console.error("Backend screening execution error:", error);
        return res.status(500).json({ error: "Internal server processing failure.", details: error.message });
    }
}
