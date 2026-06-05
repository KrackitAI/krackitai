import Groq from "groq-sdk";

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

        const systemPrompt = `You are a strict applicant tracking system (ATS) scanner. 
        Analyze the candidate's resume profile text and return a raw JSON response.
        
        CRITICAL: Do not include any markdown syntax formatting, do not use backticks (\`\`\`), and do not include any conversational intro/outro text. Return ONLY valid JSON matching this schema:
        {
            "score": 85,
            "critique": "A brief summary of structural weaknesses or overall impact metrics.",
            "missingKeywords": ["Supabase", "REST APIs", "Tailwind"]
        }`;

        const completion = await groq.chat.completions.create({
            // Using the 8B model bypasses the 70B daily token limit freeze instantly
            model: "llama-3.1-8b-instant",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Here is my resume context:\n\n${resumeText}` }
            ],
            temperature: 0.1,
            // Forces the Groq compiler to return an isolated object structure
            response_format: { type: "json_object" }
        });

        const rawContent = completion.choices[0].message.content.trim();
        const parsedData = JSON.parse(rawContent);

        return res.status(200).json(parsedData);

    } catch (error) {
        console.error("Backend screening execution error:", error);
        return res.status(500).json({ 
            error: "Internal server processing failure.", 
            details: error.message 
        });
    }
}
