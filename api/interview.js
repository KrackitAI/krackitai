import Groq from "groq-sdk";

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        let parsedBody = req.body;
        if (typeof parsedBody === 'string') {
            parsedBody = JSON.parse(parsedBody);
        }

        const { jobDescription, resume, chatHistory } = parsedBody;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: 'Missing required parameters.' });
        }

        const apiKey = process.env.GROQ_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'Configuration Error' });
        }

        const groq = new Groq({ apiKey: apiKey });

        const systemPersona = `
You are a brilliant, highly critical, and professional technical interviewer. 
Your goal is to conduct a live, realistic back-and-forth mock interview based on the provided Job Description and Candidate Resume.

CRITICAL CONVERSATIONAL RULES:
1. Ask exactly ONE sharp question at a time. Never dump multiple questions.
2. Listen closely to the candidate's responses. Challenge their assumptions or dig deeper if they do well.

CRITICAL ADAPTIVE PACING & TURNS CONTROL:
1. You must ask exactly 5 distinct technical questions.
2. Track the conversation length via the history log. On your 5th turn, ask your 5th and final technical question normally. DO NOT say goodbye or conclude the interview on this turn.

THE CRITICAL EVALUATION TURN (TURN 6):
After the candidate submits their 5th answer, you enter your 6th and final turn. On this turn, you must calculate their final grade and compile a brutally honest, direct technical performance review.
You must return your output strictly as a valid JSON object on this final turn. Do not include markdown text wrappers outside the JSON structure.

JSON Structure for Turn 6:
{
  "isConcluded": true,
  "aiMessage": "Your final spoken goodbye message to the candidate (e.g., 'That concludes our technical evaluation today. Your data has been processed. Goodbye.')",
  "score": 45, 
  "verdict": "REJECTED / STRONG REJECT / PASS / STRONG PASS",
  "brutallyHonestReview": "A detailed, critical, and completely unvarnished assessment of their performance. Point out exactly where their technical knowledge failed, where they sounded shallow, and what specific concepts they completely got wrong based on their answers.",
  "gapsToFix": ["Concept 1", "Concept 2", "Concept 3"]
}

For standard conversation turns (Turns 1 through 5), simply reply with a normal plain text message containing your next interview question. Do not return JSON during standard turns.

Context Profile Data:
Target Job Description: ${jobDescription}
Candidate Background Resume: ${resume}
`;

        const apiMessagesPayload = [
            { role: "system", content: systemPersona },
            ...chatHistory
        ];

        // Determine if we are on the final evaluation turn to enforce JSON constraints
        const assistantTurnsCount = chatHistory.filter(msg => msg.role === 'assistant').length;
        const isFinalEvaluationTurn = (assistantTurnsCount >= 5);

        const requestPayload = {
            messages: apiMessagesPayload,
            model: "llama-3.3-70b-versatile",
            temperature: 0.4,
            max_tokens: 800
        };

        if (isFinalEvaluationTurn) {
            requestPayload.response_format = { type: "json_object" };
        }

        const chatCompletion = await groq.chat.completions.create(requestPayload);
        const rawResponseContent = chatCompletion.choices[0].message.content.trim();

        if (isFinalEvaluationTurn) {
            // Parse the JSON data safely to hand back to the frontend report stage
            const parsedEvaluationData = JSON.parse(rawResponseContent);
            return res.status(200).json(parsedEvaluationData);
        } else {
            // Return standard question format
            return res.status(200).json({ aiMessage: rawResponseContent, isConcluded: false });
        }

    } catch (error) {
        console.error("Live Agent Exception:", error);
        return res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
}
