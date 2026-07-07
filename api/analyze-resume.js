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

        // STEP 1: Use the LLM to extract keywords, synonyms, and importance weights
        const systemPrompt = `You are a ruthless, top-tier FAANG Technical Recruiter. 
        
        TASK 1: Extract exactly 10 to 12 skills required from the provided Job Description. Distinguish between 'Critical' (must-have) and 'Bonus' (nice-to-have) skills. For each skill, provide an array of 2-3 common synonyms or formatting variations (e.g., "Kubernetes", "K8s").
        
        TASK 2: Provide a brutal, section-by-section critique of the candidate's resume. Do not be polite. Call out specific weak bullet points, missing quantifiable metrics, and poor phrasing in their Experience and Projects sections.
        
        ${isTealMode ? `TARGET JOB DESCRIPTION TO EXTRACT FROM:\n${jobDescription}\n\n` : ''}
        
        CRITICAL: Return ONLY valid JSON matching this schema:
        {
            "extractedSkills": [
                {
                    "skill": "React",
                    "synonyms": ["React.js", "ReactJS"],
                    "isCritical": true
                }
            ],
            "sectionCritiques": [
                "Experience: Your second bullet point under TechLabs is weak. 'Assisted in hardware bring-up' means nothing. What was the impact?"
            ]
        }`;

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `CANDIDATE RESUME TEXT:\n\n${resumeText}` }
            ],
            temperature: 0.0, // HARD ZERO. We need deterministic, reproducible parsing.
            response_format: { type: "json_object" }
        });

        const rawContent = completion.choices[0].message.content.trim();
        const parsedData = JSON.parse(rawContent);
        
        // Fallback safety (Structured for the new schema)
        const extractedSkills = Array.isArray(parsedData.extractedSkills) ? parsedData.extractedSkills : [
            { skill: "JavaScript", synonyms: ["JS", "Node.js"], isCritical: true },
            { skill: "APIs", synonyms: ["REST", "GraphQL"], isCritical: true },
            { skill: "Git", synonyms: ["GitHub", "Version Control"], isCritical: false }
        ];
        const critiquesArray = Array.isArray(parsedData.sectionCritiques) ? parsedData.sectionCritiques : ["Resume lacks quantifiable metrics and strong action verbs."];

        // STEP 2: SEMANTIC REGEX MATCHING (The Real ATS Engine)
        const missing = [];
        const found = [];
        let maxPossiblePoints = 0;
        let earnedPoints = 0;

        extractedSkills.forEach(item => {
            // Must-haves are worth 10 points. Nice-to-haves are worth 3 points.
            const weight = item.isCritical ? 10 : 3; 
            maxPossiblePoints += weight;

            // Build a strict regex pattern: \b(Skill|Syn1|Syn2)\b 
            // This ensures "Java" doesn't match "JavaScript", and "React" doesn't match "Reaction"
            const searchTerms = [item.skill, ...(item.synonyms || [])].map(term => 
                term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special characters safely
            );
            const regexPattern = new RegExp(`\\b(${searchTerms.join('|')})\\b`, 'i');

            if (regexPattern.test(resumeText)) {
                found.push(item.skill);
                earnedPoints += weight;
            } else {
                missing.push(item.skill);
            }
        });

        // STEP 3: DETERMINISTIC MATH (WEIGHTED MODEL)
        let calculatedScore = 0;
        if (maxPossiblePoints > 0) {
            // Pure percentage of weighted points earned
            calculatedScore = Math.round((earnedPoints / maxPossiblePoints) * 100);
            
            // The Corporate Reality Ceiling: If you miss ANY critical 'Must-Have' skill, 
            // you are heavily penalized and mathematically cannot score above an 82.
            const missedCritical = extractedSkills.some(item => item.isCritical && !found.includes(item.skill));
            if (missedCritical && calculatedScore > 82) {
                calculatedScore = 82;
            }
            
            // Hard floor to prevent zeros
            if (calculatedScore < 15) calculatedScore = 15;
            if (calculatedScore > 100) calculatedScore = 100;
        }

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
