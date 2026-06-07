import { Groq } from "groq-sdk";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed." });
    }

    try {
        const { jobDescription, resume, chatHistory } = req.body;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: "Missing required profile parameters." });
        }

        // ─── STAGE 1: DYNAMIC LIFECYCLE PROGRESS TRACKER ────────────────
        // Count real questions by looking for assistant messages containing "?" 
        // and excluding the initial greeting turn.
        const totalTechnicalQuestionsAsked = chatHistory.filter((msg, idx) => 
            msg.role === "assistant" && 
            msg.content.includes("?") &&
            idx > 0 // Ignores the very first greeting block natively
        ).length;

        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= 5 || isTimeCeilingReached;

        // ─── STAGE 2: ADAPTIVE DOMAIN SYSTEM PROMPT ─────────────────────
        const systemPrompt = `You are an expert corporate interviewer tailored precisely to the domain of the provided Job Description.

Target Role Context:
${jobDescription}

Candidate Resume Profile:
${resume}

YOUR PERSONA MANDATE:
- If this is the very first turn of the interview, dynamically invent a highly realistic name, an industry-accurate corporate title (e.g., Creative Director for design, VP of Sales for business, Principal Engineer for tech), and a fictitious target company that perfectly fits the job description.
- Maintain this exact persona consistently across the entire chat log.

STRICT PACING AND CONVERSATIONAL CONTRACT:
1. You must deliver exactly 5 comprehensive domain-specific interview questions throughout this session.
2. Current Progress State: [ Questions Asked So Far: ${totalTechnicalQuestionsAsked} / 5 ].
3. CRITICAL: Never deploy a transitional message or remark as a standalone message. You MUST append the actual scenario question directly inside that very same turn. Every single response you send while isConcluded is false MUST end with a clear question mark "?".
4. Once totalTechnicalQuestionsAsked reaches 5, or if a timeout occurs, you must immediately set "isConcluded" to true, write a brief sign-off statement in "aiMessage", and generate the final grade.

DATA OUTPUT SCHEMA:
You must output a raw JSON object matching this schema exactly. Do not use markdown backticks wrappers:
{
    "aiMessage": "Your next tailored interview question ending with a '?'. If concluding, write your final goodbye wrap-up text.",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
    "score": ${forceSessionConclusion ? "An integer between 1 and 100 based on performance." : "0"},
    "verdict": "${forceSessionConclusion ? "Set to 'OFFER EXTENDED (PROVISIONAL)' if score >= 70, otherwise set to 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "A piercing, unvarnished peer-level evaluation review tailored to this role's domain." : "Active session live."}",
    "gapsToFix": ${forceSessionConclusion ? "A flat string array of conceptual or domain-specific knowledge deficiencies found." : "[]"}
}

CRITICAL RULES:
- If isConcluded is false, score MUST be 0, verdict MUST be "PENDING", and gapsToFix MUST be [].`;

        // ─── STAGE 3: EXECUTE GROQ COMPILATION PIPELINE ─────────────────
        const cleanPayloadArray = [
            { role: "system", content: systemPrompt },
            ...chatHistory
        ];

        const groqCompletionResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: cleanPayloadArray,
            temperature: 0.3, 
            max_tokens: 1200,
            response_format: { type: "json_object" }
        });

        const rawJsonStringOutput = groqCompletionResponse.choices[0].message.content;
        const parsedReportObjectPayload = JSON.parse(rawJsonStringOutput);

        // ─── DEFENSIVE VERIFICATION SHIELD ──────────────────────────────
        if (parsedReportObjectPayload.isConcluded) {
            let finalCalculatedScore = parseInt(parsedReportObjectPayload.score) || 0;
            
            if (finalCalculatedScore <= 10 && finalCalculatedScore > 0) {
                finalCalculatedScore = finalCalculatedScore * 10;
            }
            parsedReportObjectPayload.score = finalCalculatedScore;

            if (finalCalculatedScore >= 70) {
                parsedReportObjectPayload.verdict = "OFFER EXTENDED (PROVISIONAL)";
            } else {
                parsedReportObjectPayload.verdict = "REJECTED";
                
                if (!parsedReportObjectPayload.gapsToFix || parsedReportObjectPayload.gapsToFix.length === 0) {
                    parsedReportObjectPayload.gapsToFix = [
                        "Domain depth fell short of the required role threshold.",
                        "Core situational answers lacked optimal structural precision.",
                        "Review the unvarnished critique block for detailed concepts to study."
                    ];
                }
            }
        }

        return res.status(200).json(parsedReportObjectPayload);

    } catch (error) {
        console.error("🚨 API ROUTE CRASH ERROR:", error);
        return res.status(500).json({ 
            error: "Internal server processing failure.", 
            details: error.message 
        });
    }
}
