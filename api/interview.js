import { Groq } from "groq-sdk";

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed." });
    }

    try {
        // ─── STAGE 1: PAYLOAD EXTRACTION & HINT DETECTION ───────────────
        const { jobDescription, resume, chatHistory, isHintRequest } = req.body;

        if (!jobDescription || !resume || !chatHistory) {
            return res.status(400).json({ error: "Missing required profile parameters." });
        }

        // Smart Hint Detection: Checks if the frontend sent a flag OR if the user literally typed "hint"
        const lastUserMessage = chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === "user" 
            ? chatHistory[chatHistory.length - 1].content.toLowerCase() 
            : "";
        const isHintMode = isHintRequest === true || lastUserMessage.includes("hint") || lastUserMessage.includes("help");

        // ─── STAGE 2: BULLETPROOF MATH COUNTER ──────────────────────────
        // We filter out any past AI messages that contained the "[HINT]" tag so they don't consume the 5-question limit.
        const assistantMessageCount = chatHistory.filter(msg => msg.role === "assistant" && !msg.content.includes("[HINT]")).length;
        const totalTechnicalQuestionsAsked = Math.max(0, assistantMessageCount - 1);

        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= 5 || isTimeCeilingReached;
        
        let conclusionReason = "N/A";
        if (isTimeCeilingReached) conclusionReason = "TIME_EXPIRED";
        else if (totalTechnicalQuestionsAsked >= 5) conclusionReason = "ALL_QUESTIONS_ANSWERED";

        // ─── STAGE 3: ADAPTIVE DOMAIN SYSTEM PROMPT ─────────────────────
        const systemPrompt = `You are an expert corporate interviewer tailored precisely to the domain of the provided Job Description.

Target Role Context:
${jobDescription}

Candidate Resume Profile:
${resume}

YOUR PERSONA MANDATE:
- Dynamically invent a highly realistic name, an industry-accurate corporate title, and a fictitious company matching the job description on turn 1. Maintain it consistently.
- CRITICAL TURN 1 RULE: On your very first message, you MUST introduce yourself AND immediately ask the first technical scenario question. Do not wait for the candidate to say hello.

STRICT PACING AND CONVERSATIONAL CONTRACT:
1. You must deliver exactly 5 comprehensive domain-specific interview questions. This is a standalone 5-question sprint. There are NO coding rounds, NO debugging rounds, and NO subsequent interviews. 
2. Current Progress State: [ Questions Asked So Far: ${totalTechnicalQuestionsAsked} / 5 ].
3. CRITICAL: NEVER promise or suggest future rounds, coding tests, or next steps to the candidate.
4. ${isHintMode ? 
    "HINT DIRECTIVE ACTIVE: The candidate is asking for a hint or help. You MUST start your response exactly with '[HINT]'. Provide a brief, conceptual clue or guidance. DO NOT ask a new question. DO NOT answer the current question entirely for them. Wait for their actual response." : 
    "THE HUMAN ELEMENT: You must sound like a real human engineer. For questions 2 through 5, you MUST briefly react to the candidate's previous answer before asking the next question. Validate their good points or correct their mistakes."}
5. ${isHintMode ? 
    "NO QUESTION MARK ALLOWED: Because this is a hint turn, you are just providing a clue. Do not end your message with a question mark." : 
    "THE QUESTION MARK RULE: After your conversational feedback, seamlessly transition into your next technical question. Every single active response MUST end with a clear technical question mark '?'."}
6. SESSION CONCLUSION STATUS: [ ${forceSessionConclusion ? `TRUE - THE INTERVIEW IS OVER.` : `FALSE - THE INTERVIEW IS ACTIVE.`} ].
${forceSessionConclusion ? "" : "CRITICAL RULE: You are FORBIDDEN from ending the interview early. You MUST output isConcluded: false."}

GRADING OBJECTIVE DIRECTIVE:
${forceSessionConclusion ? `The interview has ended. Evaluate the candidate's answers. If their technical depth was weak, you MUST give a low score, set the verdict to REJECTED, and write a critical review. Do NOT compliment a failing candidate.` : `The interview is active. Do not generate final grades, scores, or reviews yet.`}

DATA OUTPUT SCHEMA:
You must output a raw JSON object matching this schema exactly:
{
    "aiMessage": "${forceSessionConclusion ? (conclusionReason === 'TIME_EXPIRED' ? 'Write a brief goodbye stating time expired.' : 'Write a brief goodbye stating they have completed all 5 questions.') : (isHintMode ? 'Your conceptual [HINT] text here. No questions.' : 'First, briefly react to their previous answer. Then, ask your next tailored interview question ending with a ?.')}",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
    "score": ${forceSessionConclusion ? "An integer between 1 and 100 based on performance." : "0"},
    "verdict": "${forceSessionConclusion ? "Set to 'ACCEPTED' if score >= 70, otherwise set to 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "A piercing, unvarnished peer-level evaluation review. If the candidate failed, focus entirely on their mistakes. Do not praise them." : "Active session live."}",
    "gapsToFix": ${forceSessionConclusion ? "A flat string array of specific constructive areas to remediate." : "[]"}
}`;

        // ─── STAGE 4: EXECUTE GROQ COMPILATION PIPELINE ─────────────────
        const cleanPayloadArray = [
            { role: "system", content: systemPrompt },
            ...chatHistory
        ];

        const groqCompletionResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: cleanPayloadArray,
            temperature: 0.15, 
            max_tokens: 1200,
            response_format: { type: "json_object" }
        });

        const rawJsonStringOutput = groqCompletionResponse.choices[0].message.content;
        const parsedReportObjectPayload = JSON.parse(rawJsonStringOutput);

        // ─── STAGE 5: DEFENSIVE VERIFICATION SHIELD & AI HANDCUFFS ──────
        
        // Stop Illegal Early Terminations
        if (parsedReportObjectPayload.isConcluded === true && forceSessionConclusion === false) {
            parsedReportObjectPayload.isConcluded = false;
            parsedReportObjectPayload.score = 0;
            parsedReportObjectPayload.verdict = "PENDING";
            parsedReportObjectPayload.gapsToFix = [];
            
            const msgLower = (parsedReportObjectPayload.aiMessage || "").toLowerCase();
            if (msgLower.includes("5 questions") || msgLower.includes("conclude") || msgLower.includes("goodbye") || msgLower.includes("thank you")) {
                parsedReportObjectPayload.aiMessage = "Good points. Let's pivot slightly and dive a bit deeper. Based on our discussion so far, what specific structural trade-offs would you consider if we scaled this architecture by 10x?";
            }
        }

        // The Smart Question Mark Enforcer (Bypassed if user is just asking for a hint)
        if (parsedReportObjectPayload.isConcluded === false && !isHintMode) {
            let aiMsg = parsedReportObjectPayload.aiMessage || "";
            aiMsg = aiMsg.replace(/let's simulate.*next/ig, "").replace(/in the next round.*/ig, "").trim();
            
            if (!aiMsg.includes("?")) {
                if (totalTechnicalQuestionsAsked === 0) {
                    aiMsg += " To get started, what would be your initial approach to designing the core architecture for this role's primary system?";
                } else {
                    aiMsg += " Given these constraints, how would you approach the next critical component of this design?";
                }
            }
            parsedReportObjectPayload.aiMessage = aiMsg;
        }

        // ─── STAGE 6: GRADING NORMALIZATION BLOCK ───────────────────────
        if (parsedReportObjectPayload.isConcluded) {
            let finalCalculatedScore = parseInt(parsedReportObjectPayload.score) || 0;
            
            if (finalCalculatedScore <= 10 && finalCalculatedScore > 0) {
                finalCalculatedScore = finalCalculatedScore * 10;
            }
            parsedReportObjectPayload.score = finalCalculatedScore;

            if (finalCalculatedScore >= 70) {
                // FIXED VERDICT STRING: Now explicitly says ACCEPTED instead of Offer Extended
                parsedReportObjectPayload.verdict = "ACCEPTED"; 
                
                const reviewText = (parsedReportObjectPayload.brutallyHonestReview || "").toLowerCase();
                if (!parsedReportObjectPayload.gapsToFix || parsedReportObjectPayload.gapsToFix.length === 0) {
                    const fallbackGaps = [];
                    if (reviewText.includes("communication") || reviewText.includes("refining")) {
                        fallbackGaps.push("Refine behavioral articulation and communication delivery.");
                    }
                    if (reviewText.includes("deeper") || reviewText.includes("depth")) {
                        fallbackGaps.push("Elaborate on fine-grained architectural trade-offs.");
                    }
                    if (fallbackGaps.length === 0 && finalCalculatedScore < 100) {
                        fallbackGaps.push("Polish contextual explanation speed and structural precision.");
                    }
                    parsedReportObjectPayload.gapsToFix = fallbackGaps;
                }
            } else {
                parsedReportObjectPayload.verdict = "REJECTED";
                
                const reviewText = (parsedReportObjectPayload.brutallyHonestReview || "").toLowerCase();
                if (reviewText.includes("fit for our") || reviewText.includes("impressive") || reviewText.includes("aced") || reviewText.includes("great fit")) {
                    parsedReportObjectPayload.brutallyHonestReview = "The technical depth provided across your interview answers fell significantly short of our production engineering requirements. Core architectural trade-offs lacked standard structural precision and critical optimizations.";
                }

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
