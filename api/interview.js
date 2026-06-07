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

        // ─── STAGE 1: BULLETPROOF MATH COUNTER ──────────────────────────
        const assistantMessageCount = chatHistory.filter(msg => msg.role === "assistant").length;
        const totalTechnicalQuestionsAsked = Math.max(0, assistantMessageCount - 1);

        const isTimeCeilingReached = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= 5 || isTimeCeilingReached;
        
        let conclusionReason = "N/A";
        if (isTimeCeilingReached) conclusionReason = "TIME_EXPIRED";
        else if (totalTechnicalQuestionsAsked >= 5) conclusionReason = "ALL_QUESTIONS_ANSWERED";

        // ─── STAGE 2: ADAPTIVE DOMAIN SYSTEM PROMPT ─────────────────────
        const systemPrompt = `You are an expert corporate interviewer tailored precisely to the domain of the provided Job Description.

Target Role Context:
${jobDescription}

Candidate Resume Profile:
${resume}

YOUR PERSONA MANDATE:
- Dynamically invent a highly realistic name, an industry-accurate corporate title, and a fictitious company matching the job description on turn 1. Maintain it consistently.

STRICT PACING AND CONVERSATIONAL CONTRACT:
1. You must deliver exactly 5 comprehensive domain-specific interview questions. This is a standalone 5-question sprint. There are NO coding rounds, NO debugging rounds, and NO subsequent interviews. 
2. Current Progress State: [ Questions Asked So Far: ${totalTechnicalQuestionsAsked} / 5 ].
3. CRITICAL: NEVER promise or suggest future rounds, coding tests, or next steps to the candidate.
4. CRITICAL: Never deploy a transitional remark as a standalone message. Every single response you send while the interview is active MUST end with a clear technical question mark "?".
5. SESSION CONCLUSION STATUS: [ ${forceSessionConclusion ? `TRUE - THE INTERVIEW IS OVER.` : `FALSE - THE INTERVIEW IS ACTIVE.`} ].
${forceSessionConclusion ? "" : "CRITICAL RULE: You are FORBIDDEN from ending the interview early. You MUST output isConcluded: false and ask a technical question."}

GRADING OBJECTIVE DIRECTIVE:
${forceSessionConclusion ? `The interview has ended. Evaluate the candidate's answers. If their technical depth was weak, you MUST give a low score, set the verdict to REJECTED, and write a critical review. Do NOT compliment a failing candidate.` : `The interview is active. Do not generate final grades, scores, or reviews yet.`}

DATA OUTPUT SCHEMA:
You must output a raw JSON object matching this schema exactly:
{
    "aiMessage": "${forceSessionConclusion ? (conclusionReason === 'TIME_EXPIRED' ? 'Write a brief goodbye stating time expired.' : 'Write a brief goodbye stating they have completed all 5 questions.') : 'Your next tailored interview question ending with a ?.'}",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
    "score": ${forceSessionConclusion ? "An integer between 1 and 100 based on performance." : "0"},
    "verdict": "${forceSessionConclusion ? "Set to 'OFFER EXTENDED (PROVISIONAL)' if score >= 70, otherwise set to 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? "A piercing, unvarnished peer-level evaluation review. If the candidate failed, focus entirely on their mistakes. Do not praise them." : "Active session live."}",
    "gapsToFix": ${forceSessionConclusion ? "A flat string array of specific constructive areas to remediate." : "[]"}
}`;

        // ─── STAGE 3: EXECUTE GROQ COMPILATION PIPELINE ─────────────────
        const cleanPayloadArray = [
            { role: "system", content: systemPrompt },
            ...chatHistory
        ];

        const groqCompletionResponse = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            messages: cleanPayloadArray,
            temperature: 0.1, 
            max_tokens: 1200,
            response_format: { type: "json_object" }
        });

        const rawJsonStringOutput = groqCompletionResponse.choices[0].message.content;
        const parsedReportObjectPayload = JSON.parse(rawJsonStringOutput);

        // ─── DEFENSIVE VERIFICATION SHIELD & AI HANDCUFFS ───────────────
        
        // HANDCUFF 1: Stop Illegal Early Terminations
        if (parsedReportObjectPayload.isConcluded === true && forceSessionConclusion === false) {
            parsedReportObjectPayload.isConcluded = false;
            parsedReportObjectPayload.score = 0;
            parsedReportObjectPayload.verdict = "PENDING";
            parsedReportObjectPayload.gapsToFix = [];
            
            const msgLower = (parsedReportObjectPayload.aiMessage || "").toLowerCase();
            if (msgLower.includes("5 questions") || msgLower.includes("conclude") || msgLower.includes("goodbye") || msgLower.includes("thank you")) {
                parsedReportObjectPayload.aiMessage = "Let's pivot slightly and dive a bit deeper. Based on our discussion so far, what specific structural trade-offs would you consider if we scaled this architecture by 10x?";
            }
        }

        // HANDCUFF 2: The Question Mark Enforcer
        // If the interview is active, the AI MUST ask a question. If it forgot, we force one in.
        if (parsedReportObjectPayload.isConcluded === false) {
            let aiMsg = parsedReportObjectPayload.aiMessage || "";
            // Strip out any hallucinated promises about coding rounds
            aiMsg = aiMsg.replace(/let's simulate.*next/ig, "").replace(/in the next round.*/ig, "").trim();
            
            if (!aiMsg.includes("?")) {
                aiMsg += " Given these constraints, how would you approach the next critical component of this design?";
            }
            parsedReportObjectPayload.aiMessage = aiMsg;
        }

        // ────────────────────────────────────────────────────────────────

        // Grading Normalization Block
        if (parsedReportObjectPayload.isConcluded) {
            let finalCalculatedScore = parseInt(parsedReportObjectPayload.score) || 0;
            
            if (finalCalculatedScore <= 10 && finalCalculatedScore > 0) {
                finalCalculatedScore = finalCalculatedScore * 10;
            }
            parsedReportObjectPayload.score = finalCalculatedScore;

            if (finalCalculatedScore >= 70) {
                parsedReportObjectPayload.verdict = "OFFER EXTENDED (PROVISIONAL)";
                
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
