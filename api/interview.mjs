export default async function handler(req, res) {
  // 1. Method check
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 2. Get and parse inputs safely
    let parsedBody = req.body;
    if (typeof req.body === 'string') {
      parsedBody = JSON.parse(req.body);
    }

    const { jobDescription, resume, userId } = parsedBody || {};

    if (!jobDescription || !resume) {
      return res.status(400).json({
        error: 'Please provide both a job description and resume'
      });
    }

    // 3. Rate limiting stub (free tier = 3 sessions)
    const userKey = userId || req.headers['x-forwarded-for'] || 'anonymous';
    const usageCount = await getUsageCount(userKey);

    if (usageCount >= 3) {
      return res.status(403).json({
        error: 'free_limit_reached',
        message: 'You have used your 3 free sessions. Upgrade to continue.',
        upgradeUrl: '/upgrade'
      });
    }

    // 4. Build smart prompt
    const prompt = buildPrompt(jobDescription, resume);

    // 5. Call Groq with timeout protection
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile', // FIXED: Production model name
          messages: [
            {
              role: 'system',
              content: 'You are an expert interview coach. Always respond with valid JSON only. No extra text, no markdown backticks.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.7,
          max_tokens: 3000
        })
      }
    );

    clearTimeout(timeout);

    // 6. Parse response
    const data = await response.json();

    if (!data.choices || !data.choices[0]) {
      throw new Error('Invalid response from AI');
    }

    const text = data.choices[0].message.content;
    const cleaned = text.replace(/```json|```/gi, '').trim();
    const result = JSON.parse(cleaned);

    // 7. Track usage
    await incrementUsage(userKey);

    // 8. Add usage info to response
    result.sessionsUsed = usageCount + 1;
    result.sessionsRemaining = Math.max(0, 3 - (usageCount + 1));

    return res.status(200).json(result);

  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(408).json({ error: 'Request timed out - please try again' });
    }
    if (error instanceof SyntaxError) {
      return res.status(500).json({ error: 'AI returned invalid format - please try again' });
    }
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Something went wrong - please try again', details: error.message });
  }
}

// PROMPT BUILDER
function buildPrompt(jobDescription, resume) {
  return `You are an expert interview coach. Analyse this job description and resume carefully.

JOB DESCRIPTION:
${jobDescription}

CANDIDATE RESUME:
${resume}

Generate a personalised interview preparation pack. Return ONLY this JSON structure:
{
  "roleTitle": "detected job title",
  "readinessScore": 75,
  "strengths": ["strength 1", "strength 2", "strength 3"],
  "weaknesses": ["gap 1", "gap 2"],
  "questions": [
    {
      "id": 1,
      "category": "Behavioural",
      "question": "question text",
      "idealAnswer": "detailed answer using their resume experience",
      "tip": "one line coaching tip",
      "difficulty": "Medium"
    }
  ],
  "salaryNegotiationTip": "one specific tip based on the role",
  "keywordsToMention": ["keyword1", "keyword2", "keyword3"]
}

Rules:
- Generate exactly 8 questions
- Mix: 3 behavioural, 3 technical, 2 situational
- Ideal answers MUST reference specific details from their resume
- Readiness score between 40-95 based on how well resume matches job
- JSON only - no extra text`;
}

// USAGE TRACKING (Stubs wired to mock handlers)
async function getUsageCount(userKey) {
  return 0; // Keeping it free while building as directed by step notes
}

async function incrementUsage(userKey) {
  console.log(`Session used by: ${userKey}`);
}
