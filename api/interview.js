import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { jobDescription, resume, chatHistory } = req.body;

        // Count base turns to monitor token usage and enforce the safety ceiling
        const ongoingTurnsCount = chatHistory.filter(msg => msg.role === "user" && !msg.content.includes("SYSTEM NOTE: HUB_HINT_REQUEST")).length;

        const systemPrompt = `You are Rohan Khanna, a senior elite technical interviewer conducting a realistic, adaptive mock simulation.
        
        Target Role Context: ${jobDescription}
        Candidate Resume Profile: ${resume}

        YOUR MANDATE:
        You have absolute dynamic authority to determine the length of this interview. Evaluate the candidate's technical depth adaptively.
        - If their answers are shallow, drill deeper with aggressive technical follow-ups.
        - Once you have gathered sufficient data matrices to confidently form a passing or failing hiring verdict (typically between 3 to 6 turns), wrap up the session.
        - CRITICAL SAFETY: If the interview reaches ${ongoingTurnsCount} turns and you are still undecided, you MUST force a conclusion now to protect the token budget.

        SPECIAL LIFELINE HANDLING:
        - If the last message from the user contains "SYSTEM NOTE: HUB_HINT_REQUEST", the candidate is stuck on your immediate previous question.
        - DO NOT ask a new question. DO NOT provide code solutions or give away the direct answer.
        - Instead, provide a subtle, clear, conceptual 2-sentence hint or alternative framing to unblock them.
        - Flag this internal state change. If the interview concludes later, factor these requested hints into the final metric calculations by deducting 5 points per hint from the final score.

        OUTPUT SPECIFICATIONS:
        You must return a raw JSON object matching this schema exactly. No markdown wraps, no backticks.
        {
            "aiMessage": "Your next technical question, OR your helpful conceptual hint if requested, OR your polite closing wrap-up statement if concluding.",
            "isConcluded": false, 
            "score": 0,
            "brutallyHonestReview": "",
            "gapsToFix": []
        }

        DYNAMIC CLOSURE RULES:
        If you decide you have enough signal to conclude (or hit the safety ceiling), change "isConcluded" to true and fully populate the metrics:
        1. "score": Integer (1-100) assessing technical communication, depth, and applying a penalty for any hints used.
        2. "brutallyHonestReview": A direct, peer-level review outlining exactly why they passed or failed, explicitly mentioning if they relied on lifelines.
        3. "gapsToFix": A flat array of strings detailing specific technical concepts or tools they stumbled on or needed hints to understand.

        If the interview is ongoing, "isConcluded" MUST be false, and score/review/gaps MUST be empty/0.`;

        // Keep core context clear and protect the token envelope
        const preservedSystemHeader = { role: "system", content: systemPrompt };
        const streamlinedRecentHistory = chatHistory.slice(-6).filter(msg => msg.role !== 'system');
        const finalPayloadMessages = [preservedSystemHeader, ...streamlinedRecentHistory];

        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: finalPayloadMessages,
            temperature: 0.3,
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
