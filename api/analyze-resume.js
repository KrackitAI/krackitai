import { Groq } from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// Vercel/Next.js Pages Router function config.
// NOTE: maxDuration must live INSIDE this config object for Pages Router API routes.
export const config = {
    api: {
        bodyParser: {
            sizeLimit: '5mb',
        },
    },
    maxDuration: 60,
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function sanitizeJson(rawContent) {
    const backticks = String.fromCharCode(96, 96, 96);
    return rawContent
        .trim()
        .replace(new RegExp('^' + backticks + '(?:json)?\\n?', 'gi'), '')
        .replace(new RegExp(backticks + '$', 'g'), '')
        .trim();
}

const REQUIREMENTS_SCHEMA = {
    type: "object",
    properties: {
        requirements: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    skill: { type: "string" },
                    tier: { type: "string", enum: ["dealbreaker", "critical", "bonus"] },
                    synonyms: { type: "array", items: { type: "string" } }
                },
                required: ["skill", "tier", "synonyms"],
                additionalProperties: false
            }
        }
    },
    required: ["requirements"],
    additionalProperties: false
};

const CANDIDATE_SCHEMA = {
    type: "object",
    properties: {
        experienceTimeline: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    company: { type: "string" },
                    startDate: { type: "string" },
                    endDate: { type: "string" },
                    isCurrent: { type: "boolean" },
                    skillsUsed: { type: "array", items: { type: "string" } }
                },
                required: ["company", "startDate", "endDate", "isCurrent", "skillsUsed"],
                additionalProperties: false
            }
        },
        sectionCritiques: { type: "array", items: { type: "string" } }
    },
    required: ["experienceTimeline", "sectionCritiques"],
    additionalProperties: false
};

// ---------------------------------------------------------------------------
// STEP A: Extract tiered requirements from the JOB DESCRIPTION ONLY.
// This is intentionally independent of any candidate resume, so every
// applicant to the same job is judged against the exact same yardstick.
// Result is cached (see getCachedRequirements/saveCachedRequirements) so
// this only runs once per unique job description, not once per resume.
// ---------------------------------------------------------------------------
async function extractRequirementsFromJD(groq, jobDescription) {
    const systemPrompt = `You are a ruthless, top-tier FAANG Technical Recruiter.

TASK: Extract exactly 10 to 12 skills required from the Job Description into three strict tiers:
- "dealbreaker": Absolute mandatory requirements (e.g., specific clearances, required degrees, core languages).
- "critical": Core skills necessary for the job.
- "bonus": Nice-to-have skills.
For each, provide an array of 2-3 common synonyms or formatting variations (e.g., "Kubernetes", "K8s").

IMPORTANT: This tiering will be reused as the fixed scoring rubric for every candidate who applies to this exact job. Base your tiers ONLY on the job description text below — do not consider any specific candidate.

JOB DESCRIPTION:
${jobDescription}

Return ONLY valid JSON matching the schema.`;

    const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Extract the tiered requirements now." }
        ],
        temperature: 0.0,
        max_completion_tokens: 1500,
        reasoning_effort: "low",
        response_format: {
            type: "json_schema",
            json_schema: { name: "requirements_extraction", strict: true, schema: REQUIREMENTS_SCHEMA }
        }
    });

    const parsed = JSON.parse(sanitizeJson(completion.choices[0].message.content));
    return Array.isArray(parsed.requirements) ? parsed.requirements : [];
}

// ---------------------------------------------------------------------------
// STEP A (fallback): No JD was provided at all, so derive baseline skills
// from the resume itself. This is inherently candidate-specific, so it is
// NOT cached — there is no stable JD to key the cache on.
// ---------------------------------------------------------------------------
async function extractRequirementsFromResume(groq, resumeText) {
    const systemPrompt = `You are a ruthless, top-tier FAANG Technical Recruiter.

No job description was provided for this screening. Extract 10 standard industry skills based on the candidate's own resume below, and tier all of them as "critical". Provide 2-3 synonyms for each.

CANDIDATE RESUME:
${resumeText}

Return ONLY valid JSON matching the schema.`;

    const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Extract the requirements now." }
        ],
        temperature: 0.0,
        max_completion_tokens: 1500,
        reasoning_effort: "low",
        response_format: {
            type: "json_schema",
            json_schema: { name: "requirements_extraction", strict: true, schema: REQUIREMENTS_SCHEMA }
        }
    });

    const parsed = JSON.parse(sanitizeJson(completion.choices[0].message.content));
    return Array.isArray(parsed.requirements) ? parsed.requirements : [];
}

// ---------------------------------------------------------------------------
// STEP B: Parse this specific candidate's timeline and write the critique,
// against the ALREADY FIXED requirements list from Step A. This call never
// re-derives or reinterprets what the job requires.
// ---------------------------------------------------------------------------
async function analyzeCandidate(groq, resumeText, requirements) {
    const requirementsSummary = requirements
        .map(r => `${r.skill} (${r.tier})`)
        .join(', ');

    const systemPrompt = `You are a ruthless, top-tier FAANG Technical Recruiter and Data Extractor.

The job's required skills have ALREADY been determined and are FIXED for this screening. Do not reinterpret, add to, or remove from this list — just use it as context:
${requirementsSummary}

TASK 1 (CANDIDATE TIMELINE): Parse the candidate's chronological work experience. For each role, extract "company", "startDate" (YYYY-MM), "endDate", "isCurrent", and a concise array of "skillsUsed" in that specific role. DO NOT extract full sentences or bullet points.

TASK 2 (CRITIQUE): Provide a brutal, section-by-section critique calling out weak bullet points, missing quantifiable metrics, poor phrasing, and any of the fixed required skills above that appear absent from this candidate's background.

CANDIDATE RESUME TEXT:
${resumeText}

Return ONLY valid JSON matching the schema.`;

    const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-20b",
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "Analyze this candidate now." }
        ],
        temperature: 0.0,
        max_completion_tokens: 2500,
        reasoning_effort: "low",
        response_format: {
            type: "json_schema",
            json_schema: { name: "candidate_analysis", strict: true, schema: CANDIDATE_SCHEMA }
        }
    });

    const parsed = JSON.parse(sanitizeJson(completion.choices[0].message.content));
    return {
        timeline: Array.isArray(parsed.experienceTimeline) ? parsed.experienceTimeline : [],
        critiques: Array.isArray(parsed.sectionCritiques) ? parsed.sectionCritiques : ["Formatting optimization advised."]
    };
}

// ---------------------------------------------------------------------------
// Requirement cache (Supabase). Fails OPEN: any cache error just means we
// fall back to a fresh LLM extraction rather than crashing the request.
// ---------------------------------------------------------------------------
async function getCachedRequirements(supabase, jdHash) {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase
            .from('jd_requirements_cache')
            .select('requirements')
            .eq('jd_hash', jdHash)
            .maybeSingle();
        if (error) {
            console.error("Cache read error (continuing without cache):", error.message);
            return null;
        }
        return data ? data.requirements : null;
    } catch (err) {
        console.error("Cache read exception (continuing without cache):", err.message);
        return null;
    }
}

async function saveCachedRequirements(supabase, jdHash, requirements) {
    if (!supabase || !jdHash) return;
    try {
        await supabase
            .from('jd_requirements_cache')
            .upsert({ jd_hash: jdHash, requirements }, { onConflict: 'jd_hash' });
    } catch (err) {
        console.error("Cache write exception (non-fatal):", err.message);
    }
}

// ---------------------------------------------------------------------------
// Employer override support: lets a hiring manager correct the LLM's tier
// assignment for specific skills (e.g. bump "C++" from critical -> dealbreaker).
// Expects req.body.requirementOverrides = [{ skill: "C++", tier: "dealbreaker" }, ...]
// ---------------------------------------------------------------------------
function applyOverrides(requirements, overrides) {
    if (!Array.isArray(overrides) || overrides.length === 0) return requirements;

    const overrideMap = new Map(
        overrides
            .filter(o => o && typeof o.skill === 'string' && typeof o.tier === 'string')
            .map(o => [o.skill.trim().toLowerCase(), o.tier])
    );

    return requirements.map(req => {
        const overrideTier = overrideMap.get((req.skill || '').trim().toLowerCase());
        return overrideTier ? { ...req, tier: overrideTier } : req;
    });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!process.env.GROQ_API_KEY) {
        return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    let supabase = null;
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    } else {
        console.warn("ATS ENGINE: Supabase not fully configured — JD requirement caching disabled for this request.");
    }

    try {
        const { resumeText, jobDescription, requirementOverrides } = req.body;

        if (!resumeText) {
            return res.status(400).json({ error: 'Missing resume context data profile.' });
        }

        const isTealMode = jobDescription && jobDescription.length > 50;

        console.log("ATS ENGINE: Resolving job requirements...");

        let requirements;
        let jdHash = null;

        if (isTealMode) {
            jdHash = crypto.createHash('sha256').update(jobDescription.trim()).digest('hex');
            requirements = await getCachedRequirements(supabase, jdHash);

            if (requirements && requirements.length > 0) {
                console.log("ATS ENGINE: Cache hit — reusing existing requirement tiers for this JD.");
            } else {
                console.log("ATS ENGINE: No cache hit — extracting requirements from JD via Groq...");
                requirements = await extractRequirementsFromJD(groq, jobDescription);
                await saveCachedRequirements(supabase, jdHash, requirements);
            }
        } else {
            console.log("ATS ENGINE: No JD provided — deriving baseline requirements from resume (not cached).");
            requirements = await extractRequirementsFromResume(groq, resumeText);
        }

        // Apply any employer-provided tier corrections, and persist them for
        // future candidates screened against this same job description.
        if (Array.isArray(requirementOverrides) && requirementOverrides.length > 0) {
            requirements = applyOverrides(requirements, requirementOverrides);
            if (jdHash) {
                await saveCachedRequirements(supabase, jdHash, requirements);
            }
        }

        console.log("ATS ENGINE: Analyzing candidate against fixed requirements...");
        const { timeline, critiques: parsedCritiques } = await analyzeCandidate(groq, resumeText, requirements);
        const critiquesArray = parsedCritiques;

        console.log("ATS ENGINE: Candidate parsed. Calculating math...");

        // LAYER 2: EVIDENCE DENSITY HEURISTICS (Lightning Fast JS String Parsing)
        const resumeLines = resumeText.split('\n').filter(line => line.trim().length > 30);
        let strongBullets = 0;
        let totalMonths = 0;
        let validRolesCount = 0;
        const strongVerbRegex = /\b(architected|led|drove|spearheaded|engineered|developed|built|designed|launched|managed|scaled|optimized|increased|decreased|reduced)\b/i;

        resumeLines.forEach(line => {
            const hasMetrics = /\d/.test(line) || /[%$]/.test(line);
            const hasOwnership = strongVerbRegex.test(line);
            if (hasMetrics || hasOwnership) strongBullets++;
        });

        const evidenceRatio = resumeLines.length > 0 ? (strongBullets / resumeLines.length) : 0.5;

        // Calculate Tenure and Trajectory
        timeline.forEach(role => {
            if (role.startDate) {
                const start = new Date(role.startDate);
                let end = role.endDate && role.endDate.toLowerCase() !== 'present' ? new Date(role.endDate) : new Date();
                if (!isNaN(start) && !isNaN(end)) {
                    const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
                    if (months > 0) {
                        totalMonths += months;
                        validRolesCount++;
                    }
                }
            }
        });

        const avgTenure = validRolesCount > 0 ? totalMonths / validRolesCount : 0;
        let trajectoryMultiplier = 1.0;
        if (validRolesCount > 1 && avgTenure < 12) trajectoryMultiplier = 0.85;
        else if (avgTenure >= 24) trajectoryMultiplier = 1.1;

        // LAYER 3: SEMANTIC REGEX WITH TRUE RECENCY WEIGHTING
        const missing = [];
        let maxPossiblePoints = 0;
        let earnedPoints = 0;
        let dealbreakersMissed = 0;
        let criticalMissed = 0;

        requirements.forEach(req => {
            const isDealbreaker = req.tier === 'dealbreaker';
            const isCritical = req.tier === 'critical';

            const weight = isDealbreaker ? 0 : (isCritical ? 10 : 3);
            maxPossiblePoints += weight;

            // Safe regex that handles C++, .NET without word boundary failures
            const searchTerms = [req.skill, ...(req.synonyms || [])].map(term =>
                term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            );
            const regexPattern = new RegExp(`(?<![a-zA-Z0-9])(${searchTerms.join('|')})(?![a-zA-Z0-9])`, 'i');

            let maxRecencyMultiplier = 0;
            let foundInTimeline = false;

            // PROPER RECENCY CHECK: Scan the specific skills tied to each job era
            for (const role of timeline) {
                const roleSkillsBlob = Array.isArray(role.skillsUsed) ? role.skillsUsed.join(' ') : '';

                if (regexPattern.test(roleSkillsBlob)) {
                    maxRecencyMultiplier = Math.max(maxRecencyMultiplier, role.isCurrent ? 1.0 : 0.6);
                    foundInTimeline = true;
                }
            }

            // Fallback for raw lists (skills dumped at the bottom with no dates get a 40% penalty)
            if (!foundInTimeline && regexPattern.test(resumeText)) {
                maxRecencyMultiplier = 0.4;
            }

            if (maxRecencyMultiplier > 0) {
                earnedPoints += (weight * maxRecencyMultiplier);
            } else {
                missing.push(req.skill);
                if (isDealbreaker) dealbreakersMissed++;
                if (isCritical) criticalMissed++;
            }
        });

        // LAYER 4: THE CORPORATE REALITY GUILLOTINE
        let calculatedScore = 0;
        let keywordScore = 0;

        if (maxPossiblePoints > 0) {
            keywordScore = (earnedPoints / maxPossiblePoints) * 75;
        } else {
            keywordScore = dealbreakersMissed > 0 ? 0 : 75;
        }

        const evidenceScore = Math.min(evidenceRatio * 25 * trajectoryMultiplier, 25);
        calculatedScore = Math.round(keywordScore + evidenceScore);

        if (dealbreakersMissed > 0) {
            calculatedScore = Math.min(calculatedScore, 20);
            critiquesArray.unshift(`🚨 DEALBREAKER MISSING: You are missing absolute requirements (${missing.slice(0, 2).join(', ')}). This is an auto-reject.`);
        } else if (criticalMissed > 0) {
            // Dynamic Cap: 1 missed = max 70, 2 missed = max 55, 3 missed = max 40
            const dynamicCap = Math.max(40, 85 - (criticalMissed * 15));
            calculatedScore = Math.min(calculatedScore, dynamicCap);
            critiquesArray.unshift(`⚠️ CRITICAL MISSING: You missed ${criticalMissed} core skills. Your score has been forcefully capped at ${dynamicCap}.`);
        }

        if (calculatedScore < 15) calculatedScore = 15;
        if (calculatedScore > 100) calculatedScore = 100;

        console.log("ATS ENGINE: Completed successfully. Returning score:", calculatedScore);

        // LAYER 5: EXPLAINABLE PAYLOAD RETURN
        return res.status(200).json({
            score: calculatedScore,
            sectionCritiques: critiquesArray,
            missingKeywords: missing,
            // Echoed back so a frontend can show/edit tiers and resend as
            // requirementOverrides on a future request against this same JD.
            appliedRequirements: requirements,
            breakdown: {
                keywordScore: Math.round(keywordScore),
                evidenceScore: Math.round(evidenceScore),
                evidenceRatio: Number(evidenceRatio.toFixed(2)),
                trajectoryMultiplier: Number(trajectoryMultiplier.toFixed(2)),
                averageTenureMonths: Math.round(avgTenure),
                dealbreakersMissed,
                criticalMissed
            }
        });

    } catch (error) {
        console.error("Backend screening execution error:", error);
        return res.status(500).json({ error: "Internal server processing failure.", details: error.message });
    }
}
