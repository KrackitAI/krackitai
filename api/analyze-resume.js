import { Groq } from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { resumeText } = req.body;
        if (!resumeText) {
            return res.status(400).json({ error: 'Missing resume context data profile.' });
        }

        const systemPrompt = `You are a strict Applicant Tracking System (ATS) and Senior Technical Recruiter. 
        Analyze the candidate's resume profile text and return a raw JSON evaluation.
        
        SCORING RUBRIC (Evaluate based on engineering best practices):
        - 90-100: Top tier. Heavy use of quantifiable metrics, strong action verbs, clear structural impact.
        - 75-89: Solid fit. Good skills but lacks some depth, scale, or measurable impact.
        - 50-74: Mediocre. Generic descriptions, missing key industry keywords, weak formatting.
        - 1-49: Poor. Barebones, confusing, or highly irrelevant to the tech industry.

        CRITICAL: Do not include any markdown syntax formatting, do not use backticks, and do not include conversational text. Return ONLY valid JSON matching this schema:
        {
            "score": <Generate a dynamic integer between 1 and 100 based strictly on the rubric>,
            "critique": "<A piercing 1-2 sentence summary of their structural weaknesses, formatting flaws, or missing impact metrics>",
            "missingKeywords": ["<Core skill 1 lacking>", "<Core skill 2 lacking>", "<Core skill 3 lacking>"]
        }`;

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Here is the candidate's resume text:\n\n${resumeText}` }
            ],
            temperature: 0.2, // Bumped slightly to 0.2 to allow dynamic math calculation
            response_format: { type: "json_object" }
        });

        const rawContent = completion.choices[0].message.content.trim();
        const parsedData = JSON.parse(rawContent);

        // ─── DEFENSIVE VERIFICATION SHIELD ──────────────────────────────
        // Ensure the LLM didn't spit out a string or a decimal for the score
        let finalScore = parseInt(parsedData.score) || 50;
        if (finalScore <= 10 && finalScore > 0) finalScore = finalScore * 10; // Catch 1-10 GPA scale hallucinations
        parsedData.score = finalScore;
        
        // Ensure missing keywords is always an array so the frontend map() doesn't crash
        if (!Array.isArray(parsedData.missingKeywords)) {
            parsedData.missingKeywords = ["Quantifiable Metrics", "Structural Depth"];
        }
        // ────────────────────────────────────────────────────────────────

        return res.status(200).json(parsedData);

    } catch (error) {
        console.error("Backend screening execution error:", error);
        return res.status(500).json({ 
            error: "Internal server processing failure.", 
            details: error.message 
        });
    }
}
