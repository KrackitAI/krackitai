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

        // STEP 1: Use the LLM ONLY to extract an array of required keywords and write the critique.
        const systemPrompt = `You are a ruthless, top-tier FAANG Technical Recruiter. 
        
        TASK 1: Extract exactly 10 to 15 critical technical keywords, frameworks, or hard skills required from the provided Job Description. If no Job Description is provided, extract 10 standard industry skills based on the candidate's resume.
        
        TASK 2: Provide a brutal, section-by-section critique of the candidate's resume. Do not be polite. Call out specific weak bullet points, missing quantifiable metrics, and poor phrasing in their Experience and Projects sections.
        
        ${isTealMode ? `TARGET JOB DESCRIPTION TO EXTRACT FROM:\n${jobDescription}\n\n` : ''}
        
        CRITICAL: Return ONLY valid JSON matching this schema:
        {
            "extractedKeywords": ["<Skill 1>", "<Skill 2>", "<Skill 3>"],
            "sectionCritiques": [
                "Experience: Your second bullet point under TechLabs is weak. 'Assisted in hardware bring-up' means nothing. What was the impact?",
                "Projects: You list an IoT project but fail to mention the exact data throughput or cloud architecture."
            ]
        }`;

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `CANDIDATE RESUME TEXT:\n\n${resumeText}` }
            ],
            temperature: 0.1, 
            response_format: { type: "json_object" }
        });

        const rawContent = completion.choices[0].message.content.trim();
        const parsedData = JSON.parse(rawContent);
        
        // Fallback safety
        const requiredKeywords = Array.isArray(parsedData.extractedKeywords) ? parsedData.extractedKeywords : ["JavaScript", "APIs", "Git", "Teamwork"];
        const critiquesArray = Array.isArray(parsedData.sectionCritiques) ? parsedData.sectionCritiques : ["Resume lacks quantifiable metrics and strong action verbs."];

        // STEP 2: DETERMINISTIC JAVASCRIPT MATCHING (The Real ATS Engine)
        const resumeLower = resumeText.toLowerCase();
        const missing = [];
        const found = [];

        requiredKeywords.forEach(keyword => {
            if (resumeLower.includes(keyword.toLowerCase())) {
                found.push(keyword);
            } else {
                missing.push(keyword);
            }
        });

        // STEP 3: DETERMINISTIC MATH
        let calculatedScore = 0;
        if (requiredKeywords.length > 0) {
            calculatedScore = Math.round((found.length / requiredKeywords.length) * 100);
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
