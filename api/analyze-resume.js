import { Groq } from '@groq/sdk'; // Or your preferred LLM client wrapper

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    const { resumeText } = req.body;
    if (!resumeText) return res.status(400).json({ error: 'Missing resume text context' });

    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant", // Use a fast, highly capable reasoning model
            response_format: { type: "json_object" },
            temperature: 0.2, // Low temperature for consistent grading metrics
            messages: [
                {
                    role: "system",
                    content: `You are an elite, brutally honest technical recruiter and ATS parsing engine. 
                    Analyze the provided resume text. Critique it severely on impact metrics, formatting traps, missing core skills, and clarity.
                    You must return strictly a JSON object with this exact structure:
                    {
                        "score": number (0 to 100),
                        "critique": "string (one sentence unvarnished, blunt flaw assessment)",
                        "missingKeywords": ["string", "string"]
                    }`
                },
                { role: "user", content: `Analyze this resume text:\n\n${resumeText}` }
            ]
        });

        const analysisResult = JSON.parse(completion.choices[0].message.content);
        return res.status(200).json(analysisResult);
    } catch (error) {
        console.error("Resume screening fault:", error);
        return res.status(500).json({ error: "Failed to parse resume screening data matrices." });
    }
}
