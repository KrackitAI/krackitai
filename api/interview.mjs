import Groq from "groq-sdk";

// Initialize the API client inside the request handler loop to guarantee environment variable availability
export default async function handler(req, res) {
    // Explicitly handle preflight CORS or non-POST requests cleanly
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { jobDescription, resume } = req.body;

        if (!jobDescription || !resume) {
            return res.status(400).json({ error: 'Missing required payload parameters: jobDescription and resume are mandatory.' });
        }

        // Verify that the Vercel Environment key is readable at runtime
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            console.error("CRITICAL BACKEND ERROR: GROQ_API_KEY is completely missing or unreadable in the Vercel dashboard.");
            return res.status(500).json({ 
                error: "Backend Configuration Error", 
                details: "The server API key is missing. Ensure GROQ_API_KEY is configured correctly inside your Vercel Environment Variables project settings." 
            });
        }

        // Safe, isolated SDK instantiation
        const groq = new Groq({ apiKey: apiKey });

        const targetPrompt = `
You are an expert, brutally honest technical interviewer and engineering career coach. 
Analyze the provided Job Description and Candidate Resume, then generate exactly 5 specific interview questions tailored to test the candidate's actual background constraints against the job requirements.

You must return your output strictly as a valid JSON object. Do not include any markdown formatting, wrappers, backticks, or trailing text blocks.

JSON Structure:
{
  "roleTitle": "Extracted Target Role Title String",
  "salaryNegotiationTip": "A sharp, specific tip on how this candidate should negotiate salary based on their strengths and the role demands.",
  "keywordsToMention": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "questions": [
    {
      "id": 1,
      "category": "Technical/Behavioral/System Architecture",
      "difficulty": "Medium/Hard",
      "question": "The specific interview question targeting a detail in their resume or requirement in the job description."
    }
  ]
}

Data to analyze:
Job Description: ${jobDescription}
Candidate Resume: ${resume}
`;

        const chatCompletion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "You output strictly valid JSON documents without markdown wrappers or backticks." },
                { role: "user", content: targetPrompt }
            ],
            model: "llama-3.3-70b-specdec",
            response_format: { type: "json_object" },
            temperature: 0.3,
            max_tokens: 1500
        });

        const rawContent = chatCompletion.choices[0].message.content.trim();
        
        // Safety Fallback: Strip out any rogue markdown wrappers if the LLM leaked them despite settings
        let cleanJsonString = rawContent;
        if (cleanJsonString.startsWith("```json")) {
            cleanJsonString = cleanJsonString.replace(/^
```json\s*/i, "").replace(/\s*```$/, "");
        } else if (cleanJsonString.startsWith("```")) {
            cleanJsonString = cleanJsonString.replace(/^```\s*/i, "").replace(/\s*```$/, "");
        }

        const parsedContent = JSON.parse(cleanJsonString);
        return res.status(200).json(parsedContent);

    } catch (error) {
        console.error("Vercel Function Processing Exception:", error);
        return res.status(500).json({ 
            error: "Internal execution processing error handler tripped.", 
            details: error.message 
        });
    }
}
