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

        // Check if the user provided a real Job Description (longer than 50 chars)
        const isTealMode = jobDescription && jobDescription.length > 50;

        const systemPrompt = `You are a strict Applicant Tracking System (ATS) and Senior Technical Recruiter. 
        Analyze the candidate's resume against ${isTealMode ? 'the provided TARGET JOB DESCRIPTION' : 'standard tech industry expectations'} and return a raw JSON evaluation.
        
        ${isTealMode ? `TARGET JOB DESCRIPTION TO MATCH AGAINST:\n${jobDescription}\n\n` : ''}
        
        SCORING RUBRIC:
        - 90-100: Top tier. ${isTealMode ? 'Perfect alignment with the Job Description keywords and skills.' : 'Heavy use of quantifiable metrics, strong action verbs.'}
        - 75-89: Solid fit. ${isTealMode ? 'Hits most core JD requirements but misses some specific tools.' : 'Good skills but lacks depth or measurable impact.'}
        - 50-74: Mediocre. ${isTealMode ? 'Missing major required keywords from the JD.' : 'Generic descriptions, missing keywords.'}
        - 1-49: Poor. ${isTealMode ? 'Completely irrelevant to the target Job Description.' : 'Barebones or highly irrelevant.'}

        CRITICAL: Do not include markdown. Return ONLY valid JSON matching this schema:
        {
            "score": <Generate a dynamic integer between 1 and 100>,
            "critique": "<A piercing 1-2 sentence summary of their gaps ${isTealMode ? 'relative to the Job Description' : 'in formatting/impact'}>",
            "missingKeywords": [
                ${isTealMode ? '"<Crucial JD keyword 1 missing from resume>"' : '"<Core industry skill 1 lacking>"'}, 
                "<Keyword 2>", 
                "<Keyword 3>"
            ]
        }`;

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `CANDIDATE RESUME TEXT:\n\n${resumeText}` }
            ],
            temperature: 0.15, 
            response_format: { type: "json_object" }
        });

        const rawContent = completion.choices[0].message.content.trim();
        const parsedData = JSON.parse(rawContent);

        // Defensive checks
        let finalScore = parseInt(parsedData.score) || 50;
        if (finalScore <= 10 && finalScore > 0) finalScore = finalScore * 10; 
        parsedData.score = finalScore;
        
        if (!Array.isArray(parsedData.missingKeywords)) {
            parsedData.missingKeywords = ["Quantifiable Metrics", "Keyword Alignment"];
        }

        return res.status(200).json(parsedData);

    } catch (error) {
        console.error("Backend screening execution error:", error);
        return res.status(500).json({ error: "Internal server processing failure.", details: error.message });
    }
}
