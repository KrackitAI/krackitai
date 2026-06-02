import Groq from "groq-sdk";

export default async function handler(req, res) {
    // 1. Enforce strict CORS and Method Handling
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // 2. Safe Body Parsing Matrix (Fixes the Vercel Undefined Bug)
        let parsedBody = req.body;
        
        if (!parsedBody) {
            return res.status(400).json({ error: 'Request body is completely empty.' });
        }

        // If Vercel passed the body as a raw unparsed string, parse it manually
        if (typeof parsedBody === 'string') {
            try {
                parsedBody = JSON.parse(parsedBody);
            } catch (jsonErr) {
                return res.status(400).json({ 
                    error: 'Invalid JSON payload structure received.', 
                    details: jsonErr.message 
                });
            }
        }

        const { jobDescription, resume } = parsedBody;

        if (!jobDescription || !resume) {
            return res.status(400).json({ 
                error: 'Missing fields.', 
                details: `Received jobDescription length: ${jobDescription ? jobDescription.length : 0}, resume length: ${resume ? resume.length : 0}` 
            });
        }

        // 3. Secure Key Validation
        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ 
                error: 'Backend Configuration Error', 
                details: 'GROQ_API_KEY environment variable is inaccessible to the server runtime.' 
            });
        }

        // 4. Instantiate SDK inside the handler runtime
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
        
        let cleanJsonString = rawContent;
        if (cleanJsonString.startsWith("```json")) {
            cleanJsonString = cleanJsonString.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
        } else if (cleanJsonString.startsWith("```")) {
            cleanJsonString = cleanJsonString.replace(/^```\s*/i, "").replace(/\s*```$/, "");
        }

        const parsedContent = JSON.parse(cleanJsonString);
        return res.status(200).json(parsedContent);

    } catch (error) {
        console.error("Fatal Runtime Exception Block Triggered:", error);
        return res.status(500).json({ 
            error: "Internal Server Error", 
            details: error.message 
        });
    }
}
