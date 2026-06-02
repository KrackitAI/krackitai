import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        const { jobDescription, resume } = req.body;

        if (!jobDescription || !resume) {
            return res.status(400).json({ error: 'Missing required payload parameters' });
        }

        // Structural formatting instruction prompt for Llama-3.3
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
                { role: "system", content: "You output strictly valid JSON documents without markdown wrappers." },
                { role: "user", content: targetPrompt }
            ],
            model: "llama-3.3-70b-specdec",
            response_format: { type: "json_object" },
            temperature: 0.3,
            max_tokens: 1500
        });

        const parsedContent = JSON.parse(chatCompletion.choices[0].message.content);
        return res.status(200).json(parsedContent);

    } catch (error) {
        console.error("Backend prompt stream exception:", error);
        return res.status(500).json({ error: "Internal generation execution error", details: error.message });
    }
}
