import { Groq } from "groq-sdk";
import { createClient } from "@supabase/supabase-js";

// maxDuration must live INSIDE config for Pages Router API routes (a bare
// top-level export only works in App Router and is silently ignored here).
// Also adding a bodyParser size limit: every turn resends the full resume,
// JD, and growing chat history, so the default 1mb cap can get hit on
// longer sessions.
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '5mb',
        },
    },
    maxDuration: 60,
};

// Single model for every tier. llama-3.1-8b-instant and llama-3.3-70b-versatile
// are both deprecated on Groq; openai/gpt-oss-20b is the current recommended
// replacement for both, and comes out cheaper than the old 70b elite route
// while still being a meaningfully stronger reasoner than the old 8b route.
const GROQ_MODEL = "openai/gpt-oss-20b";

// ---------------------------------------------------------------------------
// SENIORITY DETECTION — deterministic, keyword-based, runs entirely in JS.
// This deliberately does NOT cost an extra LLM call: it's a regex pass over
// the job description text, feeding into both the question-style guidance
// given to the interviewer AND the rubric weighting below. A real hiring
// manager calibrates both difficulty and what they're listening for based
// on the level of the role — this is that same judgment made explicit and
// consistent instead of left to the model to infer differently each run.
// ---------------------------------------------------------------------------
function detectSeniorityLevel(jobDescription) {
    const jd = jobDescription.toLowerCase();

    if (/\b(director|vp|vice president|head of engineering)\b/.test(jd)) return 'lead';
    if (/\b(engineering manager|eng\.?\s?manager|team lead|tech lead|technical lead)\b/.test(jd)) return 'lead';
    if (/\b(principal|distinguished|staff engineer|staff software)\b/.test(jd)) return 'senior';
    if (/\bsr\.?\s|senior\b/.test(jd)) return 'senior';
    if (/\b(junior|jr\.?\s|entry.level|new grad|graduate program|internship|intern\b|associate engineer)\b/.test(jd)) return 'entry';
    if (/\b(0-1 year|0-2 years|1-2 years of experience)\b/.test(jd)) return 'entry';

    return 'mid';
}

// Question style/difficulty guidance injected into the system prompt.
// This is the actual "senior interviewer judgment" layer: what to ask and
// what standard to hold the answer to, calibrated to the role's level.
const SENIORITY_GUIDANCE = {
    entry: `SENIORITY CALIBRATION — ENTRY LEVEL: This is a junior/entry-level role. Ask fundamentals-testing questions with a reasonably well-defined scope — test whether they understand core concepts and can reason through a guided problem, not open-ended ambiguous scenarios. Give credit for sound reasoning process even if the final answer isn't perfect. Do not expect architecture-level tradeoff discussions.`,
    mid: `SENIORITY CALIBRATION — MID LEVEL: This is a mid-level individual contributor role. Ask practical, applied questions grounded in realistic day-to-day scenarios — debugging a real failure, extending an existing system, making a reasonable tradeoff on a bounded problem. Expect solid fundamentals plus some independent judgment, but not extensive organizational ambiguity.`,
    senior: `SENIORITY CALIBRATION — SENIOR/STAFF LEVEL: This is a senior or staff-level role. Ask questions involving genuine tradeoffs with no single correct answer — system design under real constraints, weighing competing priorities (performance vs. maintainability vs. time-to-ship), edge cases, and failure modes. Expect them to justify their decisions and reasoning, not just state conclusions.`,
    lead: `SENIORITY CALIBRATION — LEAD/MANAGEMENT LEVEL: This role involves technical leadership or people management. Blend technical judgment questions with realistic people/process scenarios — guiding a team through a contentious technical decision, handling a disagreement with a peer or report, prioritizing competing stakeholder asks, or unblocking a stuck engineer. Technical depth still matters, but judgment and communication carry equal or greater weight here.`
};

// Rubric point weights per level (each triple sums to 10, so with scores
// 1-10 per category the max possible total stays 100 — same ceiling as
// before, just redistributed). Reasoning: entry-level hires are judged more
// on fundamentals + coachability than deep role-specific fit, since they're
// expected to grow into it. Mid-level keeps the original 5/3/2 split. Senior
// roles weight demonstrated fit to THIS role's specific technical demands
// more heavily. Lead/management roles weight communication highest, since
// that's the core function of the job, not a secondary skill.
const RUBRIC_WEIGHTS = {
    entry:  { tech: 5, jd: 2, comm: 3 },
    mid:    { tech: 5, jd: 3, comm: 2 },
    senior: { tech: 4, jd: 4, comm: 2 },
    lead:   { tech: 3, jd: 3, comm: 4 }
};

// ---------------------------------------------------------------------------
// COMPANY / ROUND PROFILES — "practice a specific company's interview" mode.
//
// IMPORTANT HONESTY NOTE, read before extending this: none of this content
// is sourced from any company's actual internal materials. There is no
// legitimate way to obtain that. Everything below is synthesized from
// publicly reported interview structure (multiple independent, converging
// secondary sources), NOT verified against any primary/official transcript.
// Each round below carries a `sourceNote` documenting exactly how confident
// that specific round's structure is and what it's based on. Any UI that
// surfaces this feature to users should say "modeled on publicly reported
// interview format" — never "trained on Google's real interview data,"
// because that claim would not be true.
//
// Architecture: this does NOT create a separate script per round. Every
// round is a config object that gets layered into the exact same prompt
// pipeline already used for the generic paste-your-own-JD flow (seniority
// detection, hint enforcement, error recovery, deterministic scoring all
// still apply unchanged). Only the round-specific fields below differ.
// ---------------------------------------------------------------------------
const COMPANY_PROFILES = {
    amazon: {
        displayName: "Amazon",
        roles: {
            sde: {
                displayName: "Software Development Engineer",
                syntheticJDByLevel: {
                    entry: "Software Development Engineer I, Amazon (SDE1, entry-level/new grad). Strong coding fundamentals across data structures and algorithms, and the ability to speak concretely about past work using Amazon's Leadership Principles.",
                    mid:   "Software Development Engineer II, Amazon (SDE2, mid-level, 2-5 years experience). Solid coding fundamentals, ownership of features end-to-end, growing system design judgment, and concrete examples demonstrating Amazon's Leadership Principles.",
                    senior:"Senior Software Development Engineer, Amazon (SDE3, senior level). Strong system design and architectural judgment, independent ownership of ambiguous large-scale problems, and higher-stakes, cross-team examples of Amazon's Leadership Principles in action.",
                    lead:  "Principal/Senior Manager SDE, Amazon (L6+). Cross-team technical leadership and organization-wide impact, with Leadership Principles examples expected at organizational scale, not just project scale."
                },
                rounds: {
                    phone_screen: {
                        label: "Technical Phone Screen",
                        maxQuestions: 3,
                        timeCeilingSeconds: 3000, // ~50 min
                        sourceNote: "HIGH confidence: multiple independent sources (Exponent, AccelaCoach, ApexInterviewer, all 2026-dated) consistently describe a 45-60 min single round blending one coding problem with 1-2 Leadership Principle questions, not a pure-coding screen like Google's. MEDIUM confidence on exact question difficulty, which varies by team.",
                        promptBlock: `ROUND TYPE: Amazon Technical Phone Screen (this REPLACES the standard 5-question format).
- This round is NOT pure coding. Amazon's actual reported format blends technical and behavioral: start with ONE Leadership Principle question (pick from: Customer Obsession, Ownership, Bias for Action, or Deliver Results — common early-loop picks), then move to ONE coding problem, medium difficulty.
- For the Leadership Principle question, expect and probe for the STAR structure (Situation, Task, Action, Result). If the candidate's answer is vague or lacks a quantified result, follow up and push for specifics — real Amazon interviewers are reported to do exactly this rather than accept a surface-level story.
- For the coding problem, evaluate correctness and clarity the same way a standard technical screen would.
- Keep the tone professional and thorough, not adversarial — this is a screening round, not the hardest interview in the loop.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = correctness and complexity analysis of the coding solution. "jd_alignment" = specificity and quality of the Leadership Principle story (concrete situation, individual contribution clearly separated from team's, quantified result). "communication_clarity" = whether they used a clear STAR structure for the LP answer and clarified the coding problem before diving in.`
                    },
                    onsite_coding: {
                        label: "Onsite Technical Round",
                        maxQuestions: 3,
                        timeCeilingSeconds: 2700, // 45 min
                        sourceNote: "HIGH confidence on the blended format (multiple sources explicitly state 'even for technical roles, expect at least half of your time on LP-based questions'). MEDIUM confidence on exact coding difficulty and problem style, which isn't standardized across teams.",
                        promptBlock: `ROUND TYPE: Amazon Onsite Technical Round (this REPLACES the standard 5-question format).
- Structure this the way Amazon's actual loop is reported to run: open with ONE Leadership Principle question (pick one different from any already covered this session if you have that context — Dive Deep, Have Backbone; Disagree and Commit, and Invent and Simplify are commonly reported for this stage), probe it with STAR-structure follow-ups, THEN move into ONE substantial coding problem, medium-to-hard difficulty, with a natural follow-up extension.
- At least half of this round's substance should be the Leadership Principle discussion, not just a warm-up — real Amazon interviewers are documented as scoring LP answers independently and rigorously, with follow-up probing until the candidate demonstrates real depth or runs out of detail.
- For the coding portion, expect the candidate to clarify requirements before coding — reward that the same way a standard technical round would.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = correctness and complexity analysis of the coding solution. "jd_alignment" = depth and specificity of the Leadership Principle story — Amazon's own documented rubric looks for individual contribution (not team credit), depth of tradeoff thinking, and quantified scale/impact. "communication_clarity" = clear STAR structure and whether the candidate volunteered specifics without excessive prompting.`
                    },
                    system_design: {
                        label: "System Design",
                        maxQuestions: 1,
                        timeCeilingSeconds: 2700, // 45 min
                        sourceNote: "MEDIUM confidence. Amazon's system design round is well-documented as existing and being level-gated similarly to other big tech companies (light/absent at SDE1, a real dedicated round from SDE2 onward), but I found fewer independently-converging sources specifically detailing Amazon's system design format compared to Google's — treat the level-gating claim as more provisional than the Google equivalent.",
                        promptBlock: `ROUND TYPE: System Design (this REPLACES the standard 5-question format).
- Present ONE open-ended system design scenario relevant to the role's domain, grounded in realistic production constraints (Amazon's engineering culture is documented as placing heavy weight on operational excellence and scale — ask about failure handling, monitoring, and cost/frugality tradeoffs as real dimensions of the design, not just happy-path architecture).
- LEVEL CALIBRATION: keep this lightweight or largely absent in substance for entry/SDE1 level — ask a simple, bounded design question instead of a full distributed system. At mid/SDE2, expect one coherent system with real trade-off discussion. At senior/SDE3+, expect deep architectural reasoning and explicit discussion of operational failure modes.
- It is reasonable to weave in one brief Leadership Principle follow-up related to a design decision (e.g., "why did you choose that trade-off — walk me through how you'd defend it to stakeholders") since Amazon's culture blends the two even in this round, but the bulk of this round should remain technical.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = quality of architectural reasoning, calibrated to level, with real credit given for discussing operational/failure-mode concerns. "jd_alignment" = whether the scope and depth of the design matches what's expected at the candidate's detected level. "communication_clarity" = whether they structured the design conversation logically and defended trade-offs when pushed.`
                    },
                    leadership_principles: {
                        label: "Leadership Principles (Bar Raiser Style)",
                        maxQuestions: 4,
                        timeCeilingSeconds: 3000, // ~50 min, sources describe this round as often running the full hour
                        sourceNote: "HIGH confidence — this is Amazon's own published framework, not third-party speculation: the 16 Leadership Principles are Amazon's official, public content, and were completely consistent across every source checked. The Bar Raiser role and its veto power are also well and consistently documented. What's NOT officially published is exactly which LPs get weighted most for SDE roles specifically — that emphasis is reported by interview-coaching sources, not Amazon itself, so treat the SPECIFIC principles chosen for a given session as illustrative, not an official weighting.",
                        promptBlock: `ROUND TYPE: Amazon Leadership Principles / Bar Raiser Round (this REPLACES the standard 5-question format — NO coding in this round at all).
- You are playing the role of an Amazon Bar Raiser: an experienced interviewer from OUTSIDE the hiring team, trained to keep the hiring bar high, with real weight in the final decision. Be rigorous, not casual.
- Ask behavioral questions, each one clearly targeting ONE specific named Leadership Principle. Choose from Amazon's actual 16: Customer Obsession, Ownership, Invent and Simplify, Are Right A Lot, Learn and Be Curious, Hire and Develop the Best, Insist on the Highest Standards, Think Big, Bias for Action, Frugality, Earn Trust, Dive Deep, Have Backbone; Disagree and Commit, Deliver Results, Strive to be Earth's Best Employer, Success and Scale Bring Broad Responsibility. Pick 4 DIFFERENT principles across your questions, not the same one repeated.
- Demand real, specific stories — not hypotheticals. If an answer is vague, generic, or credits "the team" without clarifying the candidate's own individual contribution, push back exactly the way a real Bar Raiser is documented to: ask what THEY personally did, how it was measured, and what they'd do differently.
- LEVEL CALIBRATION: for senior/lead candidates, expect and push for higher-stakes, cross-team examples rather than small individual tasks — this is a documented, real distinction Amazon makes by level.`,
                        rubricGuidance: `Interpret the rubric for this NON-technical round: "technical_depth" = depth of individual-contribution specificity and quantified impact in their stories (not coding ability). "jd_alignment" = how well their examples map to genuine Leadership Principle behavior rather than generic "teamwork" stories. "communication_clarity" = STAR structure and whether they volunteered concrete detail without needing to be dragged into it.`
                    }
                }
            }
        }
    },
    google: {
        displayName: "Google",
        roles: {
            swe: {
                displayName: "Software Engineer",
                // Used to synthesize a jobDescription if the frontend doesn't
                // supply one in company-round mode, so the existing seniority
                // detector and domain-adaptive logic still work unchanged.
                syntheticJDByLevel: {
                    entry: "Software Engineer, Google (L3, entry-level/new grad). Strong coding fundamentals across data structures and algorithms. General software engineering competency across distributed systems, APIs, and large-scale infrastructure typical of Google's technology stack.",
                    mid:   "Software Engineer, Google (L4, mid-level, 2-5 years experience). Solid coding fundamentals, ownership of features end-to-end, growing system design judgment. General software engineering competency across distributed systems, APIs, and large-scale infrastructure typical of Google's technology stack.",
                    senior:"Senior Software Engineer, Google (L5+, senior level). Strong system design and architectural judgment, independent ownership of ambiguous large-scale problems, mentorship expected. General software engineering competency across distributed systems, APIs, and large-scale infrastructure typical of Google's technology stack.",
                    lead:  "Staff/Tech Lead Software Engineer, Google (L6+). Cross-team technical leadership, ownership of complex systems, multiplying the output of other engineers through technical direction."
                },
                rounds: {
                    phone_screen: {
                        label: "Technical Phone Screen",
                        maxQuestions: 2,
                        timeCeilingSeconds: 3000,
                        sourceNote: "HIGH confidence: duration (45-60 min), format (1-2 coding problems on a shared doc/CoderPad, no syntax highlighting), and medium difficulty ceiling were consistent across every source checked, not a single outlier report.",
                        promptBlock: `ROUND TYPE: Technical Phone Screen (this REPLACES the standard 5-question format).
- This is a single-interviewer screening call. Ask 1-2 coding problems total, medium difficulty (not hard) — this round exists to filter, not to push to the edge of ability.
- Simulate a plain shared-document coding environment: no syntax highlighting, no autocomplete. If the candidate writes code, treat it as plain text they typed themselves.
- Actively evaluate whether the candidate asks clarifying questions before diving into a solution — jumping straight to code without clarifying constraints is a real negative signal Google is known to score on. If they don't clarify, your in-character reaction should reflect that.
- Keep the tone efficient and screening-oriented, not adversarial.`,
                        rubricGuidance: `Interpret the rubric for a phone screen: "technical_depth" = correctness and complexity analysis of their solution. "jd_alignment" = whether their coding fundamentals and problem-solving approach fit a Google engineer's baseline bar. "communication_clarity" = whether they thought out loud and clarified the problem before coding, not just whether their final explanation was articulate.`
                    },
                    onsite_coding: {
                        label: "Onsite Coding Round",
                        maxQuestions: 2,
                        timeCeilingSeconds: 2700,
                        sourceNote: "HIGH confidence on structure (45 min, medium-hard difficulty, ~2-3 of these rounds in a real loop). MEDIUM confidence on exact question content — real reports describe deliberately ambiguous problem framing at L4+, expecting the candidate to derive structure themselves, which this prompt reflects, but specific problems vary by interviewer and aren't standardized.",
                        promptBlock: `ROUND TYPE: Onsite Coding Round (this REPLACES the standard 5-question format).
- Present ONE substantial coding problem, medium-to-hard difficulty. After they reach a working solution, ask ONE natural follow-up that extends or optimizes it (e.g., "what if the input were 10x larger," "can you reduce the space complexity") — do not introduce a second unrelated problem.
- At mid/senior levels, frame the initial problem with deliberate ambiguity rather than a fully-specified spec — real Google onsite rounds are reported to expect the candidate to derive missing structure themselves, not have it handed to them.
- If the candidate gets stuck, give them room to think out loud before jumping in — reward verbalized reasoning even on an incomplete solution, this is explicitly part of what's evaluated.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = correctness, complexity analysis, and how well they handled the follow-up extension. "jd_alignment" = fit with the coding bar for the stated level (L3/L4/L5 expectations differ — hold them to the standard for their detected level). "communication_clarity" = structured thinking and handling of ambiguity, which Google is reported to weight as part of General Cognitive Ability, not just articulate speech.`
                    },
                    system_design: {
                        label: "System Design",
                        maxQuestions: 1,
                        timeCeilingSeconds: 2700,
                        sourceNote: "HIGH confidence this round exists and is open-ended/breadth-oriented at L4+. MEDIUM confidence on level calibration specifics — multiple sources agree system design is absent-or-light at L3 and a single dedicated round at L4, with L5+ sometimes getting two, but exact thresholds vary by source.",
                        promptBlock: `ROUND TYPE: System Design (this REPLACES the standard 5-question format).
- Present ONE open-ended system design scenario relevant to the role's domain (e.g., "design a service that does X at scale"). This should be breadth-oriented: guide the candidate through storage, APIs, caching, and failure handling as different dimensions of the SAME scenario, rather than asking unrelated separate questions.
- LEVEL CALIBRATION: if the candidate is at entry/L3 level, keep this deliberately lightweight (e.g., design a simple API or single-service component) — real Google L3 loops are reported to make this round light or absent entirely, so do not push distributed-systems depth on a junior candidate. At mid/L4, expect one coherent system with reasonable trade-off discussion. At senior/L5+, expect deep architectural reasoning, failure mode analysis, and real trade-off justification across the whole design.
- Prioritize real-world grounding — ask them to justify choices against production constraints, not just name-drop technologies.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = quality of architectural reasoning and trade-off justification, calibrated to their level. "jd_alignment" = whether the depth and scope of their design matches what's expected at their detected level (do not penalize an entry-level candidate for not going distributed-systems deep). "communication_clarity" = whether they structured the design conversation logically (requirements -> high-level design -> deep dives) rather than jumping straight to implementation details.`
                    },
                    googleyness: {
                        label: "Googleyness & Leadership",
                        maxQuestions: 4,
                        timeCeilingSeconds: 2700,
                        sourceNote: "HIGH confidence this round exists and is weighted heavily (multiple sources explicitly describe it as capable of overriding strong coding performance). LOWER confidence on specific question content — Google is reported to deliberately keep this evaluation open-ended/vague rather than following a fixed rubric like Amazon's published Leadership Principles, so specific questions here are illustrative, not standardized.",
                        promptBlock: `ROUND TYPE: Googleyness & Leadership (this REPLACES the standard 5-question format — NO coding or algorithm questions in this round at all).
- Ask behavioral/situational questions probing: comfort with ambiguity, bias toward action, collaborative instinct, intellectual humility (admitting mistakes/gaps), and emergent leadership (stepping up in cross-functional situations) even for individual-contributor candidates.
- Push for specific, concrete examples ("tell me about a real time this happened," not hypotheticals) and follow up on vague answers the same way you'd follow up on a weak technical answer.
- This round is reported to be weighted heavily by Google's hiring committee — do not treat it as a soft formality even though it's non-technical.`,
                        rubricGuidance: `Interpret the rubric for this NON-technical round: "technical_depth" = depth of self-reflection and specificity of examples given (not coding ability). "jd_alignment" = alignment with the Googleyness attributes described above (ambiguity tolerance, collaboration, intellectual humility, bias to action). "communication_clarity" = clarity and structure of how they told their examples (e.g., a clear situation/action/outcome structure).`
                    }
                }
            }
        }
    }
    microsoft: {
        displayName: "Microsoft",
        roles: {
            swe: {
                displayName: "Software Engineer",
                syntheticJDByLevel: {
                    entry: "Software Engineer, Microsoft (L59-L60, entry-level/new grad). Strong coding fundamentals across data structures and algorithms, object-oriented design (OOD), and a demonstrated Growth Mindset.",
                    mid:   "Software Engineer II, Microsoft (L61-L62, mid-level). Solid coding fundamentals, low-level design (LLD) proficiency, ownership of features, and behavioral alignment with Microsoft's Core Competencies.",
                    senior:"Senior Software Engineer, Microsoft (L63-L64, senior level). Strong system design (HLD) and architectural judgment, Azure/distributed systems knowledge, mentorship, and high-impact cross-team collaboration.",
                    lead:  "Principal Software Engineer, Microsoft (L65+). Organization-wide technical leadership, deep distributed system expertise, and leading major product initiatives while embodying One Microsoft values."
                },
                rounds: {
                    phone_screen: {
                        label: "Technical Phone Screen",
                        maxQuestions: 2,
                        timeCeilingSeconds: 3000,
                        sourceNote: "HIGH confidence: multiple sources consistently describe a 45-60 min round over Teams with a shared editor (no syntax highlighting), focusing on 1-2 medium DSA problems with behavioral questions mixed in.",
                        promptBlock: `ROUND TYPE: Technical Phone Screen (this REPLACES the standard 5-question format).
- Present 1-2 coding problems, medium difficulty. Common topics include arrays, strings, and linked lists.
- Simulate a plain text editor on Microsoft Teams: no autocomplete or syntax highlighting.
- Microsoft interviewers explicitly evaluate if the candidate clarifies requirements before coding. Do not give all constraints upfront; hold some back to see if they ask.
- Dedicate a small portion of the conversation (1 question) to a behavioral check, explicitly probing their "Growth Mindset" or "Learn-It-All" attitude.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = correctness and problem-solving process. "jd_alignment" = demonstrated Growth Mindset and alignment with Microsoft's cultural values. "communication_clarity" = clarifying requirements before writing code and clear articulation of edge cases.`
                    },
                    onsite_coding: {
                        label: "Onsite Data Structures & Algorithms",
                        maxQuestions: 2,
                        timeCeilingSeconds: 2700,
                        sourceNote: "HIGH confidence. Onsite loop typically includes 1-2 coding rounds of 45-60 min each. Microsoft is known to heavily integrate behavioral questions (STAR method) directly into coding rounds rather than isolating them.",
                        promptBlock: `ROUND TYPE: Onsite Coding Round (this REPLACES the standard 5-question format).
- Present ONE substantial coding problem (medium to hard difficulty depending on level). After a working solution, ask an extension or optimization question.
- Topics should skew towards classical DSA (trees, graphs, dynamic programming, strings).
- Microsoft explicitly weaves behavioral questions into technical rounds. Before or after the coding problem, ask ONE behavioral question using the STAR format, focusing on collaboration, learning from failure, or overcoming an unexpected roadblock.
- Look for clean, bug-free implementation. A buggy implementation of a basic string or array manipulation is a red flag.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = clean implementation, edge case handling, and complexity optimization. "jd_alignment" = fit with the coding bar for the level, plus the quality of their behavioral STAR response. "communication_clarity" = thinking out loud, structured communication, and receiving hints well.`
                    },
                    system_design: {
                        label: "System & Low-Level Design",
                        maxQuestions: 1,
                        timeCeilingSeconds: 2700,
                        sourceNote: "HIGH confidence. Level-gated: L59-L60 focuses on Low-Level Design (OOD). L61+ focuses on High-Level System Design (HLD) or a mix of both. Problems often mirror Microsoft products (Teams, OneDrive, Azure).",
                        promptBlock: `ROUND TYPE: System Design & Low-Level Design (this REPLACES the standard 5-question format).
- Present ONE design scenario. 
- LEVEL CALIBRATION: For entry-level (L59-L60), ask a Low-Level Design (LLD) / Object-Oriented Design question (e.g., design the classes for a parking lot, file system, or rate limiter). Expect clear class structure and relationships. For mid-level (L61-L62), blend LLD with some high-level component design. For senior+ (L63+), ask a High-Level System Design (HLD) question (e.g., design a distributed cache, Microsoft Teams backend, or Azure blob storage) expecting deep scale, fault tolerance, and database trade-offs.
- Push the candidate to explain their trade-offs. Microsoft values extensible design and security/compliance considerations.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = appropriate use of design patterns (for LLD) or scalability/fault-tolerance strategies (for HLD). "jd_alignment" = designing for enterprise scale and addressing constraints typical of Microsoft platforms. "communication_clarity" = structured architecture discussion, moving logically from requirements to design.`
                    },
                    behavioral_aa: {
                        label: "As Appropriate (AA) / Hiring Manager",
                        maxQuestions: 4,
                        timeCeilingSeconds: 3000,
                        sourceNote: "HIGH confidence. The 'As Appropriate' (AA) round is a hallmark of Microsoft's process. It serves as a final bar-raiser led by a senior manager or principal engineer. Focuses heavily on culture, impact, and probing weak signals.",
                        promptBlock: `ROUND TYPE: As Appropriate (AA) / Hiring Manager Round (this REPLACES the standard 5-question format).
- You are playing the role of the "AA" (As Appropriate) Interviewer — a senior leader with veto power over the hiring decision. This is a hybrid behavioral/strategic round.
- Ask deep behavioral questions focused on Microsoft's core competencies: Growth Mindset, Customer Focus, Adaptability, and Cross-team Collaboration. Ask them to describe their biggest failure and what they learned.
- Probe deeply. If they give a superficial answer, drill down into exactly what THEIR specific contribution was, how they handled conflict, and how they measured success.
- If the candidate is senior (L63+), ask strategic questions about project impact, mentoring, and navigating organizational ambiguity.
- You may ask one high-level technical/architecture question to double-check their fundamental understanding, but do not ask them to write code.`,
                        rubricGuidance: `Interpret the rubric for this hybrid round: "technical_depth" = depth of technical impact and strategic thinking described in their past experience. "jd_alignment" = strong demonstration of Growth Mindset, taking feedback, and "One Microsoft" collaboration. "communication_clarity" = articulate storytelling using the STAR method and lack of defensiveness when probed.`
                    }
                }
            }
        }
    }
meta: {
        displayName: "Meta",
        roles: {
            swe: {
                displayName: "Software Engineer",
                syntheticJDByLevel: {
                    entry: "Software Engineer, Meta (E3, entry-level/new grad). Exceptionally strong coding fundamentals, speed, and accuracy across data structures and algorithms. Demonstrated ability to execute quickly.",
                    mid:   "Software Engineer, Meta (E4, mid-level). Strong coding execution, solid system design foundations (Pirate), and proven project impact (Jedi).",
                    senior:"Senior Software Engineer, Meta (E5, senior level). Fast and flawless coding execution, strong distributed system architecture experience (Pirate), and demonstrated cross-functional technical leadership (Jedi).",
                    lead:  "Staff Software Engineer, Meta (E6). Architectural leadership, scaling systems to billions of users (Pirate), and driving cross-team technical direction and resolving organizational conflicts (Jedi)."
                },
                rounds: {
                    phone_screen: {
                        label: "Technical Phone Screen",
                        maxQuestions: 2,
                        timeCeilingSeconds: 2700, 
                        sourceNote: "HIGH confidence: multiple sources report a 45-minute phone screen consisting of 1-2 coding problems, expecting high speed and accuracy.",
                        promptBlock: `ROUND TYPE: Technical Phone Screen (this REPLACES the standard 5-question format).
- Present 1-2 coding problems, leaning towards arrays, strings, and trees (LeetCode Easy to Medium).
- Meta emphasizes speed and accuracy. The candidate should ideally write bug-free code quickly on a plain text editor like CoderPad, with execution disabled.
- Do not spend much time on behavioral questions; keep introductions to 2-5 minutes max.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = correctness, execution speed, and bug-free implementation. "jd_alignment" = coding competency matching Meta's high execution bar. "communication_clarity" = clear, fast articulation of the chosen approach.`
                    },
                    ninja_coding: {
                        label: "Ninja (Onsite Coding)",
                        maxQuestions: 2,
                        timeCeilingSeconds: 2700, 
                        sourceNote: "HIGH confidence: Meta's onsite coding round is internally known as the 'Ninja' interview. Standard structure is 2 algorithm questions in 45 minutes, prioritizing optimality and bug-free execution without IDE help.",
                        promptBlock: `ROUND TYPE: Ninja / Onsite Coding (this REPLACES the standard 5-question format).
- Present TWO coding problems consecutively within the 45-minute session. Keep the difficulty at LeetCode Medium.
- Meta's "Ninja" interviews expect fast, highly optimal, and bug-free code. The candidate must dry-run their code manually, as they will not have an IDE or compiler.
- If the candidate makes simple syntactical or logical errors, heavily penalize their technical depth score. Meta values execution speed and high precision.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = optimal time/space complexity, high coding speed, and manual dry-running of code. "jd_alignment" = meeting Meta's strict execution bar for the E-level. "communication_clarity" = concisely explaining trade-offs before diving into fast implementation.`
                    },
                    pirate_design: {
                        label: "Pirate (System Design)",
                        maxQuestions: 1,
                        timeCeilingSeconds: 2700, 
                        sourceNote: "HIGH confidence: Meta's system design round is known as the 'Pirate' interview. Essential for leveling (E4 vs E5 vs E6). Focuses heavily on large-scale distributed systems, data storage, and APIs.",
                        promptBlock: `ROUND TYPE: Pirate / System Design (this REPLACES the standard 5-question format).
- Present ONE large-scale system design scenario (e.g., design Instagram, Facebook News Feed, or a Messenger backend).
- LEVEL CALIBRATION: For E3, keep it to basic API and database schemas. For E4, expect a solid end-to-end architecture. For E5 and E6 (Senior/Staff), drill aggressively into deep data storage choices, extreme scale (billions of users), load balancing, and handling distributed system bottlenecks.
- Push the candidate on the "how" and "why" of their design choices, specifically querying how they store and access massive datasets.`,
                        rubricGuidance: `Interpret the rubric: "technical_depth" = deep architectural trade-offs, scalability, and data storage design. "jd_alignment" = scoping the architecture appropriately for Meta's massive user scale and their target E-level. "communication_clarity" = structuring the design cleanly from high-level to detailed components.`
                    },
                    jedi_behavioral: {
                        label: "Jedi (Behavioral)",
                        maxQuestions: 4,
                        timeCeilingSeconds: 2700, 
                        sourceNote: "HIGH confidence: Meta's behavioral round is known as the 'Jedi' interview. It focuses heavily on project impact, conflict resolution, and working in fast-paced environments.",
                        promptBlock: `ROUND TYPE: Jedi / Behavioral (this REPLACES the standard 5-question format — NO coding here).
- Ask behavioral questions probing project impact, conflict resolution (e.g., disagreements with peers or managers), and thriving in an unstructured, fast-paced environment.
- Meta's "Jedi" round highly values candidates who take ownership, resolve conflicts empathetically, and drive results despite ambiguity. 
- LEVEL CALIBRATION: For E4, focus on execution and small team conflicts. For E5/E6, focus heavily on cross-functional influence, leading without authority, and driving architectural standards across multiple teams.`,
                        rubricGuidance: `Interpret the rubric for this NON-technical round: "technical_depth" = depth of project scope and personal technical impact described. "jd_alignment" = demonstrated ability to resolve conflict and drive results at Meta's pace. "communication_clarity" = articulate, structured storytelling using the STAR method.`
                    }
                }
            }
        }
    }
};

const REPORT_SCHEMA = {
    type: "object",
    properties: {
        aiMessage: { type: "string" },
        isConcluded: { type: "boolean" },
        rubric: {
            type: "object",
            properties: {
                technical_depth: {
                    type: "object",
                    properties: { score: { type: "integer" }, reason: { type: "string" } },
                    required: ["score", "reason"],
                    additionalProperties: false
                },
                jd_alignment: {
                    type: "object",
                    properties: { score: { type: "integer" }, reason: { type: "string" } },
                    required: ["score", "reason"],
                    additionalProperties: false
                },
                communication_clarity: {
                    type: "object",
                    properties: { score: { type: "integer" }, reason: { type: "string" } },
                    required: ["score", "reason"],
                    additionalProperties: false
                }
            },
            required: ["technical_depth", "jd_alignment", "communication_clarity"],
            additionalProperties: false
        },
        verdict: { type: "string", enum: ["ACCEPTED", "REJECTED", "PENDING"] },
        brutallyHonestReview: { type: "string" },
        highlightReel: { type: "array", items: { type: "string" } },
        gapsToFix: { type: "array", items: { type: "string" } },
        behavioralAssessment: {
            type: "object",
            properties: {
                note: { type: "string" },
                severity: { type: "string", enum: ["none", "minor", "major"] }
            },
            required: ["note", "severity"],
            additionalProperties: false
        }
    },
    required: [
        "aiMessage", "isConcluded", "rubric", "verdict", "brutallyHonestReview",
        "highlightReel", "gapsToFix", "behavioralAssessment"
    ],
    additionalProperties: false
};

function sanitizeJson(rawContent) {
    const backticks = String.fromCharCode(96, 96, 96);
    return rawContent
        .trim()
        .replace(new RegExp('^' + backticks + '(?:json)?\\n?', 'gi'), '')
        .replace(new RegExp(backticks + '$', 'g'), '')
        .trim();
}

// ---------------------------------------------------------------------------
// Known Groq/gpt-oss quirk: the model occasionally represents its structured
// JSON output internally as a "tool call" even though no tools were
// requested, and Groq's endpoint rejects the mismatch with a 400
// "Tool choice is none, but model called a tool" (code: tool_use_failed)
// error. This is a documented, ongoing issue with the gpt-oss model family
// on Groq, not a bug in this prompt or schema.
//
// Critically, the model's actual generation is usually still present and
// valid inside `error.error.failed_generation`, shaped as
// {"name": "<schema name>", "arguments": {...the real response...}}. So
// instead of just failing the turn (or spending an extra call retrying
// blind), we recover the real answer directly from the error first, and
// only fall back to a genuine one-time retry if that recovery isn't
// possible.
// ---------------------------------------------------------------------------
async function callGroqWithRecovery(groq, params, attempt = 1) {
    try {
        const response = await groq.chat.completions.create(params);
        return JSON.parse(sanitizeJson(response.choices[0].message.content));
    } catch (err) {
        const isToolUseFailed = err?.status === 400 && err?.error?.error?.code === 'tool_use_failed';

        if (isToolUseFailed) {
            const failedGeneration = err?.error?.error?.failed_generation;
            if (failedGeneration) {
                try {
                    const recovered = JSON.parse(failedGeneration);
                    if (recovered && recovered.arguments && typeof recovered.arguments === 'object') {
                        console.warn("ATS ENGINE: Recovered valid response from a tool_use_failed wrapper error (no retry needed).");
                        return recovered.arguments;
                    }
                } catch (parseErr) {
                    console.warn("ATS ENGINE: Could not parse failed_generation, falling back to retry:", parseErr.message);
                }
            }

            // Recovery wasn't possible — try exactly once more before giving up.
            if (attempt < 2) {
                console.warn("ATS ENGINE: tool_use_failed with no recoverable payload, retrying once...");
                return callGroqWithRecovery(groq, params, attempt + 1);
            }
        }

        throw err;
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed." });
    }

    // Both clients are constructed here, inside the handler, rather than at
    // module scope. groq-sdk and @supabase/supabase-js both throw SYNCHRONOUSLY
    // at construction time if their key argument is missing — and a throw at
    // module load happens before this file's try/catch even exists, which
    // crashes the whole function and returns Vercel's generic non-JSON error
    // page instead of a real JSON response (this is exactly what produced the
    // "A server e..." / "not valid JSON" error on the frontend).
    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: "GROQ_API_KEY is not configured on the server." });
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: "SUPABASE_SERVICE_ROLE_KEY is not configured on the server." });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const supabaseAdmin = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zlzprbespegemxnhwnuu.supabase.co',
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    try {
        // ─── STAGE 1: PAYLOAD EXTRACTION & SECURE TIER VERIFICATION ───────
        const {
            jobDescription, resume, chatHistory, isHintRequest, tier: frontendTier,
            company, companyRole, roundType, targetLevel
        } = req.body;

        const isCompanyRoundMode = !!(company && companyRole && roundType);

        if (!resume || !chatHistory) {
            return res.status(400).json({ error: "Missing required profile parameters." });
        }
        if (!jobDescription && !isCompanyRoundMode) {
            return res.status(400).json({ error: "Missing required profile parameters." });
        }

        // Resolve the company/round profile up front so a bad company/role/
        // round combination fails clearly, before any Groq call is made.
        let roundConfig = null;
        let roleConfig = null;
        if (isCompanyRoundMode) {
            const companyProfile = COMPANY_PROFILES[company.toLowerCase()];
            roleConfig = companyProfile?.roles?.[companyRole.toLowerCase()];
            roundConfig = roleConfig?.rounds?.[roundType.toLowerCase()];
            if (!roundConfig) {
                return res.status(400).json({
                    error: "UNKNOWN_ROUND",
                    message: `No profile found for company="${company}", role="${companyRole}", round="${roundType}".`
                });
            }
        }

        let userTier = frontendTier ? frontendTier.toLowerCase() : 'free';
        let userId = null;

        const authHeader = req.headers.authorization;
        if (authHeader) {
            const token = authHeader.replace("Bearer ", "");
            const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
            if (!authError && user) {
                userId = user.id;
                const { data: profile } = await supabaseAdmin
                    .from('profiles')
                    .select('tier')
                    .eq('id', userId)
                    .single();

                if (profile && profile.tier) {
                    userTier = profile.tier.toLowerCase();
                }
            }
        }

        // Beta: give free users the Elite prompt treatment. (Left exactly as-is —
        // not part of this fix pass, per instruction.)
        if (userTier === 'free') {
            userTier = 'elite';
        }

        // ─── STAGE 2: DYNAMIC TIER ENFORCEMENT CONFIG ─────────────────────
        let maxQuestions = 5;
        let timeCeilingSeconds = 300;
        let maxHintsAllowed = 1;

        if (userTier === 'pro') {
            timeCeilingSeconds = 1200;
            maxHintsAllowed = 5;
        } else if (userTier === 'elite') {
            timeCeilingSeconds = 2700;
            maxHintsAllowed = 999;
        }

        // Company-round mode: the round's real-world format (question count,
        // duration) reflects what that round actually is — a phone screen
        // isn't a 5-question sprint — so it overrides the generic tier
        // defaults rather than stacking with them. Hint allowance stays
        // tier-based; realism of the round shouldn't change what you're
        // paying for.
        if (isCompanyRoundMode) {
            maxQuestions = roundConfig.maxQuestions;
            timeCeilingSeconds = roundConfig.timeCeilingSeconds;
        }

        const isHintMode = isHintRequest === true;

        const totalHintsUsed = chatHistory.filter(msg => msg.role === "assistant" && msg.content.includes("[HINT]")).length;
        const assistantMessageCount = chatHistory.filter(msg => msg.role === "assistant" && !msg.content.includes("[HINT]")).length;
        const totalTechnicalQuestionsAsked = Math.max(0, assistantMessageCount - 1);

        // ─── STAGE 2b: SERVER-SIDE HINT ENFORCEMENT (was computed but never
        // checked before — free/pro users had no real hint cap) ───────────
        if (isHintMode && totalHintsUsed >= maxHintsAllowed) {
            return res.status(403).json({
                error: "PAYWALL_TRIGGERED",
                reason: "HINT_LIMIT_REACHED",
                message: `You've used all ${maxHintsAllowed} hint(s) available on your current plan.`
            });
        }

        const clientSignaledTimeUp = chatHistory.some(msg => msg.content.includes("SYSTEM NOTE: TIME_CEILING_REACHED"));

        // ─── STAGE 2c: OPTIONAL SERVER-SIDE TIME VALIDATION ───────────────
        // If the frontend sends `sessionStartedAt` (ISO timestamp), we verify
        // the time limit server-side too, instead of trusting only the
        // client-injected note. Not sent by the current frontend yet — until
        // it is, this is a no-op and behavior is unchanged.
        let serverSignaledTimeUp = false;
        if (req.body.sessionStartedAt) {
            const startedAt = new Date(req.body.sessionStartedAt);
            if (!isNaN(startedAt)) {
                const elapsedSeconds = (Date.now() - startedAt.getTime()) / 1000;
                serverSignaledTimeUp = elapsedSeconds > timeCeilingSeconds;
            }
        }

        const isTimeCeilingReached = clientSignaledTimeUp || serverSignaledTimeUp;
        const forceSessionConclusion = totalTechnicalQuestionsAsked >= maxQuestions || isTimeCeilingReached;

        let conclusionReason = "N/A";
        if (isTimeCeilingReached) conclusionReason = "TIME_EXPIRED";
        else if (totalTechnicalQuestionsAsked >= maxQuestions) conclusionReason = "ALL_QUESTIONS_ANSWERED";

        // ─── STAGE 2d: SENIORITY DETECTION ────────────────────────────────
        // Company-round mode: the level is explicit (or defaults to 'mid',
        // the most commonly reported baseline external-hire level) rather
        // than regex-detected, since there may be no free-text JD to detect
        // it from. LEVEL_ALIASES lets the frontend send Google-style level
        // labels directly instead of remapping them client-side.
        const LEVEL_ALIASES = {
            l3: 'entry', entry: 'entry', junior: 'entry',
            l4: 'mid', mid: 'mid',
            l5: 'senior', senior: 'senior', staff: 'senior', l6: 'senior',
            l7: 'lead', lead: 'lead', manager: 'lead', director: 'lead'
        };

        let seniorityLevel;
        let effectiveJobDescription = jobDescription;

        if (isCompanyRoundMode) {
            seniorityLevel = LEVEL_ALIASES[(targetLevel || '').toLowerCase()] || 'mid';
            if (!effectiveJobDescription) {
                effectiveJobDescription = roleConfig.syntheticJDByLevel[seniorityLevel] || roleConfig.syntheticJDByLevel.mid;
            }
        } else {
            seniorityLevel = detectSeniorityLevel(jobDescription);
        }

        const seniorityGuidance = SENIORITY_GUIDANCE[seniorityLevel];
        const rubricWeights = RUBRIC_WEIGHTS[seniorityLevel];

        // ─── STAGE 3: ADAPTIVE DOMAIN + SENIORITY SYSTEM PROMPT ──────────
        const roundSpecificBlock = isCompanyRoundMode
            ? `${roundConfig.promptBlock}

COMPANY CONTEXT: This session is modeled on the publicly reported ${roleConfig.displayName} interview process at ${COMPANY_PROFILES[company.toLowerCase()].displayName}. This is based on public secondhand reporting, not any company's actual internal materials — stay realistic and plausible, not literal-verbatim.`
            : `QUESTION BREADTH (applies to every tier): Identify the broad technical domain implied by the job description (e.g., embedded firmware, distributed backend systems, mobile development) — not one narrow mechanism within it. Across your ${maxQuestions} questions, sample DIFFERENT meaningful subsystems or concerns within that domain rather than drilling exhaustively into a single mechanism for the whole interview. For example, for embedded firmware: concurrency/RTOS behavior, communication protocols, power management, reliability/update mechanisms, and system-level debugging are different subsystems — don't spend all ${maxQuestions} questions inside just one of these unless the job description is itself narrowly scoped to that one area.

${userTier === 'elite' ? "You are interviewing a high-level candidate. Within the breadth and realism rules above, go deeper on each subtopic than you would for a standard interview — push harder on trade-offs, edge cases, and failure modes before moving on. Be rigorous, but every question must still stay inside the realism guardrail below." : ""}`;

        const systemPrompt = `You are an expert corporate interviewer tailored precisely to the domain of the provided Job Description.
${roundSpecificBlock}

REALISM GUARDRAIL (applies to every tier and every round): Within any single question, it's good to push with a realistic "what happens if X fails" follow-up. But stop escalating a line of questioning once answering it would require solving an open research problem, or something no practicing engineer in this field could reasonably be expected to have a definitive answer for. Every question should resemble something a real hiring manager would actually ask a candidate.

${seniorityGuidance}

Target Role Context:
${effectiveJobDescription}

Candidate Resume Profile:
${resume}

YOUR PERSONA MANDATE:
- Dynamically invent a highly realistic name, an industry-accurate corporate title${isCompanyRoundMode ? ` at ${COMPANY_PROFILES[company.toLowerCase()].displayName}` : " and a fictitious company matching the job description"} on turn 1. Maintain it consistently.
- CRITICAL TURN 1 RULE: On your very first message, you MUST introduce yourself AND immediately ask the first question. Do not wait for the candidate to say hello.

STRICT PACING AND CONVERSATIONAL CONTRACT:
1. You must deliver exactly ${maxQuestions} comprehensive question(s) for this round, calibrated to the seniority level above${isCompanyRoundMode ? " and the round-specific instructions above" : ""}. This is a standalone ${maxQuestions}-question sprint.
2. Current Progress State: [ Questions Asked So Far: ${totalTechnicalQuestionsAsked} / ${maxQuestions} ].
3. ${isHintMode ?
        "HINT DIRECTIVE ACTIVE: The candidate is stuck. You MUST start your response exactly with '[HINT]'. Provide a STRICT 1-sentence conceptual nudge. You are FORBIDDEN from writing code snippets, FORBIDDEN from revealing the direct answer, and FORBIDDEN from asking follow-up questions." :
        "THE HUMAN ELEMENT: Briefly react to the candidate's previous answer before asking the next question. Validate good points or critique technical flaws. Also silently note anything about HOW they communicate (dismissive, defensive, unprofessional, evasive, or genuinely collaborative and clear) — you'll be asked to report on this at the end."}
4. ${isHintMode ? "NO QUESTION MARK ALLOWED: You are just providing a clue. Do not end your message with a question mark." : "THE QUESTION MARK RULE: Every single active response MUST end with a clear technical question mark '?'."}
5. SESSION CONCLUSION STATUS: [ ${forceSessionConclusion ? `TRUE - THE INTERVIEW IS OVER.` : `FALSE - THE INTERVIEW IS ACTIVE.`} ].

GRADING OBJECTIVE DIRECTIVE:
${forceSessionConclusion ? `The interview has ended. Evaluate performance, holding them to the standard appropriate for the seniority level described above — do not grade a junior candidate against a staff-level bar or vice versa.
${isCompanyRoundMode ? roundConfig.rubricGuidance : ""}
${userTier === 'free' ? "TIER PRIVILEGE: This user is on the FREE sandbox. You MUST write a brief, vague 1-2 sentence high-level summary for the 'brutallyHonestReview' and leave 'gapsToFix' completely empty. Do not provide diagnostic secrets." : "TIER PRIVILEGE: This user is PRO/ELITE. Provide a piercing, unvarnished peer-level technical review focusing completely on their gaps."}

BEHAVIORAL ASSESSMENT: Based on the whole conversation, set behavioralAssessment.severity to "major" ONLY if the candidate was genuinely unprofessional, dismissive, or evasive in a way that would concern a real hiring manager. Use "minor" for small issues (rambling, mild defensiveness). Use "none" if communication was professional. Put a short factual note either way.` : `The interview is active. Do not generate final grades yet. Still fill behavioralAssessment with {"note": "Active session live.", "severity": "none"}.`}

DATA OUTPUT SCHEMA:
You must output a raw JSON object matching this schema exactly:
{
"aiMessage": "${forceSessionConclusion ? (conclusionReason === 'TIME_EXPIRED' ? 'We are unfortunately out of time for today. Thank you for your time, we will be in touch with feedback.' : 'Thank you for walking me through those scenarios. That concludes our technical questions for today. We appreciate your time and will follow up shortly.') : (isHintMode ? '[HINT] Strict 1-sentence conceptual nudge. NO CODE. NO DIRECT ANSWERS. NO QUESTIONS.' : 'First, briefly react to their previous answer. Then, ask your next tailored interview question ending with a ?.')}",
    "isConcluded": ${forceSessionConclusion ? "true" : "false"},
    "rubric": {
        "technical_depth": { "score": ${forceSessionConclusion ? "<Integer 1-10>" : "0"}, "reason": "${forceSessionConclusion ? "<Max 10 words justifying tech accuracy>" : ""}" },
        "jd_alignment": { "score": ${forceSessionConclusion ? "<Integer 1-10>" : "0"}, "reason": "${forceSessionConclusion ? "<Max 10 words justifying JD alignment>" : ""}" },
        "communication_clarity": { "score": ${forceSessionConclusion ? "<Integer 1-10>" : "0"}, "reason": "${forceSessionConclusion ? "<Max 10 words critiquing articulation>" : ""}" }
    },
    "verdict": "${forceSessionConclusion ? "Set to 'ACCEPTED' if score >= 70, otherwise set to 'REJECTED'." : "PENDING"}",
    "brutallyHonestReview": "${forceSessionConclusion ? (userTier === 'free' ? "Max 15 words. Vague high-level summary." : "Max 2 sentences. Piercing, unvarnished technical review.") : "Active session live."}",
    "highlightReel": ${forceSessionConclusion ? "A string array of exactly 2 short bullet points (max 10 words each) of what they did well." : "[]"},
    "gapsToFix": ${forceSessionConclusion ? "A string array of exactly 3 short bullet points (max 10 words each) of weaknesses to study." : "[]"},
    "behavioralAssessment": { "note": "<short factual note>", "severity": "none | minor | major" }
}`;

        // ─── STAGE 4: EXECUTE GROQ COMPILATION PIPELINE ─────────────────
        const groqCallParams = {
            model: GROQ_MODEL,
            messages: [{ role: "system", content: systemPrompt }, ...chatHistory],
            temperature: 0.15,
            max_completion_tokens: 1500,
            reasoning_effort: "low",
            response_format: {
                type: "json_schema",
                json_schema: { name: "interview_turn", strict: true, schema: REPORT_SCHEMA }
            }
        };

        const parsedReportObjectPayload = await callGroqWithRecovery(groq, groqCallParams);

        // ─── STAGE 4b: DETERMINISTIC SCORING ENGINE ─────────────────────
        if (parsedReportObjectPayload.isConcluded === true && parsedReportObjectPayload.rubric) {
            const r = parsedReportObjectPayload.rubric;

            const techPoints = (r.technical_depth?.score || 0) * rubricWeights.tech;
            const jdPoints = (r.jd_alignment?.score || 0) * rubricWeights.jd;
            const commPoints = (r.communication_clarity?.score || 0) * rubricWeights.comm;

            let score = techPoints + jdPoints + commPoints;

            // Behavioral red flags can now actually move the outcome, instead of
            // being generated and then ignored. A "major" flag caps the score
            // the same way a missing dealbreaker skill caps the resume screener.
            const severity = parsedReportObjectPayload.behavioralAssessment?.severity;
            if (severity === 'major') {
                score = Math.min(score, 40);
            } else if (severity === 'minor') {
                score = Math.min(score, 80);
            }

            parsedReportObjectPayload.score = Math.round(score);
            parsedReportObjectPayload.verdict = score >= 70 ? "ACCEPTED" : "REJECTED";
        } else if (!parsedReportObjectPayload.score) {
            parsedReportObjectPayload.score = 0;
        }

        // ─── STAGE 5: DEFENSIVE VERIFICATION SHIELD & AI HANDCUFFS ──────
        if (parsedReportObjectPayload.isConcluded === true && forceSessionConclusion === false) {
            parsedReportObjectPayload.isConcluded = false;
            parsedReportObjectPayload.score = 0;
            parsedReportObjectPayload.verdict = "PENDING";
            parsedReportObjectPayload.gapsToFix = [];
        }

        if (userTier === 'free' && forceSessionConclusion) {
            parsedReportObjectPayload.gapsToFix = [];
        }

        // Echoed back so the frontend can show "This session was calibrated
        // for a Senior-level role" or similar, and so it's easy to verify
        // detection is working correctly on real job descriptions.
        parsedReportObjectPayload.detectedSeniorityLevel = seniorityLevel;
        if (isCompanyRoundMode) {
            parsedReportObjectPayload.roundMeta = {
                company: COMPANY_PROFILES[company.toLowerCase()].displayName,
                role: roleConfig.displayName,
                round: roundConfig.label,
                sourceNote: roundConfig.sourceNote
            };
        }

        return res.status(200).json(parsedReportObjectPayload);

    } catch (error) {
        console.error("🚨 API ROUTE CRASH ERROR:", error);
        return res.status(500).json({ error: "Internal server processing failure.", details: error.message });
    }
}
