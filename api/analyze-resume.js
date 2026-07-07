import { Groq } from "groq-sdk";

// 🔥 CRITICAL FIX: Prevent Vercel from killing the ATS scanner at 10 seconds
export const maxDuration = 60; 

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

        // LAYER 1: TIMELINE PARSING & REQUIREMENT TRIAGE
        // Optimized: We no longer ask it to rewrite bullet points. This saves ~1,000 tokens and 3 seconds of generation time.
        const systemPrompt = `You are a ruthless, top-tier FAANG Technical Recruiter. 
        
        TASK 1 (REQUIREMENTS): Extract exactly 10 to 12 skills from the Job Description into three strict tiers:
        - "dealbreaker": Absolute mandatory requirements (e.g., specific clearances, required degrees, core languages).
        - "critical": Core skills necessary for the job.
        - "bonus": Nice-to-have skills.
        For each, provide an array of 2-3 common synonyms (e.g., "Kubernetes", "K8s").
        
        TASK 2 (CANDIDATE TIMELINE): Parse the candidate's work experience into a chronological structure. For each role, extract the "company", "title", "startDate" (YYYY-MM), "endDate" (YYYY-MM or "Present"), and a boolean "isCurrent". DO NOT extract bullet points.
        
        TASK 3 (CRITIQUE): Provide a brutal, section-by-section critique calling out weak bullet points, missing quantifiable metrics, and poor phrasing.
        
        ${isTealMode ? `TARGET JOB DESCRIPTION:\n${jobDescription}\n\n` : 'If no JD is provided, extract 10 standard industry skills based on the candidate\\'s resume as "critical".\n\n'}
        
        CRITICAL: Return ONLY valid JSON matching this schema:
        {
            "requirements": [
                { "skill": "C++", "tier": "critical", "synonyms": ["CPP"] }
            ],
            "experienceTimeline": [
                { "company": "Tech Inc", "title": "Software Engineer", "startDate": "2020-05", "endDate": "Present", "isCurrent": true }
            ],
            "sectionCritiques": ["Experience: Bullet 2 lacks metrics. 'Fixed bugs' means nothing."]
        }`;

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `CANDIDATE RESUME TEXT:\n\n${resumeText}` }
            ],
            temperature: 0.0, 
            max_tokens: 1500, // Safety cap to prevent runaway generation
            response_format: { type: "json_object" }
        });

        const parsedData = JSON.parse(completion.choices[0].message.content.trim());
        
        const requirements = Array.isArray(parsedData.requirements) ? parsedData.requirements : [];
        const timeline = Array.isArray(parsedData.experienceTimeline) ? parsedData.experienceTimeline : [];
        const critiquesArray = Array.isArray(parsedData.sectionCritiques) ? parsedData.sectionCritiques : ["Formatting optimization advised."];

        // LAYER 2: EVIDENCE DENSITY HEURISTICS (Lightning Fast JS String Parsing)
        // We evaluate the raw text directly instead of waiting for the LLM to process it
        const resumeLines = resumeText.split('\n').filter(line => line.trim().length > 30); // Rough approximation of bullet points
        let strongBullets = 0;
        let totalMonths = 0;
        let validRolesCount = 0;
        const strongVerbRegex = /\b(architected|led|drove|spearheaded|engineered|developed|built|designed|launched|managed|scaled|optimized|increased|decreased|reduced)\b/i;
        
        resumeLines.forEach(line => {
            const hasMetrics = /\d/.test(line) || /[%$]/.test(line);
            const hasOwnership = strongVerbRegex.test(line);
            if (hasMetrics || hasOwnership) strongBullets++;
        });
        
        const evidenceRatio = resumeLines.length > 0 ? (strongBullets / resumeLines.length) : 0.5;

        // Calculate Tenure
        timeline.forEach(role => {
            if (role.startDate) {
                const start = new Date(role.startDate);
                let end = role.endDate && role.endDate.toLowerCase() !== 'present' ? new Date(role.endDate) : new Date();
                if (!isNaN(start) && !isNaN(end)) {
                    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
                    if (months > 0) {
                        totalMonths += months;
                        validRolesCount++;
                    }
                }
            }
        });
        
        const avgTenure = validRolesCount > 0 ? totalMonths / validRolesCount : 0;
        let trajectoryMultiplier = 1.0;
        if (validRolesCount > 1 && avgTenure < 12) trajectoryMultiplier = 0.85; 
        else if (avgTenure >= 24) trajectoryMultiplier = 1.1; 

        // LAYER 3: SEMANTIC REGEX WITH RECENCY WEIGHTING
        const missing = [];
        let maxPossiblePoints = 0;
        let earnedPoints = 0;
        let dealbreakersMissed = 0;
        let criticalMissed = 0;

        requirements.forEach(req => {
            const isDealbreaker = req.tier === 'dealbreaker';
            const isCritical = req.tier === 'critical';
            
            const weight = isDealbreaker ? 0 : (isCritical ? 10 : 3);
            maxPossiblePoints += weight;

            const searchTerms = [req.skill, ...(req.synonyms || [])].map(term => 
                term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') 
            );
            const regexPattern = new RegExp(`(?<![a-zA-Z0-9])(${searchTerms.join('|')})(?![a-zA-Z0-9])`, 'i');

            let maxRecencyMultiplier = 0;

            // Give full credit if they are currently working there, otherwise 60%
            for (const role of timeline) {
                if (regexPattern.test(resumeText)) { 
                    maxRecencyMultiplier = Math.max(maxRecencyMultiplier, role.isCurrent ? 1.0 : 0.6);
                }
            }

            // Fallback for raw lists (40% credit)
            if (maxRecencyMultiplier === 0 && regexPattern.test(resumeText)) {
                maxRecencyMultiplier = 0.4;
            }

            if (maxRecencyMultiplier > 0) {
                earnedPoints += (weight * maxRecencyMultiplier);
            } else {
                missing.push(req.skill);
                if (isDealbreaker) dealbreakersMissed++;
                if (isCritical) criticalMissed++;
            }
        });

        // LAYER 4: THE CORPORATE REALITY GUILLOTINE
        let calculatedScore = 0;
        let keywordScore = 0;
        
        if (maxPossiblePoints > 0) {
            keywordScore = (earnedPoints / maxPossiblePoints) * 75;
        } else {
            keywordScore = dealbreakersMissed > 0 ? 0 : 75; 
        }

        const evidenceScore = Math.min(evidenceRatio * 25 * trajectoryMultiplier, 25);
        calculatedScore = Math.round(keywordScore + evidenceScore);
        
        if (dealbreakersMissed > 0) {
            calculatedScore = Math.min(calculatedScore, 20);
            critiquesArray.unshift(`🚨 DEALBREAKER MISSING: You are missing absolute requirements (${missing.slice(0,2).join(', ')}). This is an auto-reject.`);
        } else if (criticalMissed > 0) {
            const dynamicCap = Math.max(40, 85 - (criticalMissed * 15));
            calculatedScore = Math.min(calculatedScore, dynamicCap);
            critiquesArray.unshift(`⚠️ CRITICAL MISSING: You missed ${criticalMissed} core skills. Your score has been forcefully capped at ${dynamicCap}.`);
        }
        
        if (calculatedScore < 15) calculatedScore = 15;
        if (calculatedScore > 100) calculatedScore = 100;

        return res.status(200).json({
            score: calculatedScore,
            sectionCritiques: critiquesArray,
            missingKeywords: missing,
            breakdown: {
                keywordScore: Math.round(keywordScore),
                evidenceScore: Math.round(evidenceScore),
                evidenceRatio: Number(evidenceRatio.toFixed(2)),
                trajectoryMultiplier: Number(trajectoryMultiplier.toFixed(2)),
                averageTenureMonths: Math.round(avgTenure),
                dealbreakersMissed,
                criticalMissed
            }
        });

    } catch (error) {
        console.error("Backend screening execution error:", error);
        return res.status(500).json({ error: "Internal server processing failure.", details: error.message });
    }
}
