import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { jobDescription, resume, chatHistory } = req.body;

        // Count how many questions have actually been exchanged to give the AI context
        const ongoingTurnsCount = chatHistory.filter(msg => msg.role === "user").length;

        const systemPrompt = `You are Rohan Khanna, a senior elite technical interviewer conducting a realistic, adaptive mock simulation.
        
        Target Role Context: ${jobDescription}
        Candidate Resume Profile: ${resume}

        YOUR MANDATE:
        You have absolute dynamic authority to determine the length of this interview. Do not follow a fixed question count. Evaluate the candidate's technical depth adaptively. 
        - If their answers are shallow, drill deeper with aggressive technical follow-ups.
        - Once you have gathered sufficient data matrices to confidently form a passing or failing hiring verdict (typically between 3 to 6 turns), you must wrap up the session.
        - CRITICAL SAFETY: If the interview reaches ${ongoingTurnsCount} turns and you are still undecided, you MUST force a conclusion now to protect the token budget.

        OUTPUT SPECIFICATIONS:
        You must return a raw JSON object matching this schema exactly. No markdown wraps, no backticks.
        {
            "aiMessage": "Your next sharp technical question, OR your polite closing wrap-up statement if concluding.",
            "isConcluded": false, 
            "score": 0,
            "brutallyHonestReview": "",
            "gapsToFix": []
        }

        DYNAMIC CLOSURE RULES:
        If you decide you have enough signal to conclude, change "isConcluded" to true. When "isConcluded" is true, you MUST fully populate the evaluation metrics:
        1. "score": Integer (1-100) assessing technical communication and engineering depth.
        2. "brutallyHonestReview": A direct, unvarnished, peer-level review outlining exactly why they passed or failed.
        3. "gapsToFix": A flat array of strings detailing specific technical concepts or tools they stumbled on.

        If the interview is ongoing, "isConcluded" MUST be false, and score/review/gaps MUST be empty/0.`;

        // Protect token budget by keeping the prompt template and the most recent 6 back-and-forths
        const preservedSystemHeader = { role: "system", content: systemPrompt };
        const streamlinedRecentHistory = chatHistory.slice(-6).filter(msg => msg.role !== 'system');
        const finalPayloadMessages = [preservedSystemHeader, ...streamlinedRecentHistory];

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant", // Keeps processing fast and token limits high
            messages: finalPayloadMessages,
            temperature: 0.3, // Slightly higher temperature allows natural conversational steering
            response_format: { type: "json_object" }
        });

        const rawResult = completion.choices[0].message.content.trim();
        const structuredResponse = JSON.parse(rawResult);

        return res.status(200).json(structuredResponse);

    } catch (error) {
        console.error("Simulation engine fault:", error);
        return res.status(500).json({ error: "Internal compilation failure.", details: error.message });
    }
}
