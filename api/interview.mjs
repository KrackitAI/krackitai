export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // CRUCIAL FIX: Safely parse the body if it arrives as a string
    let parsedBody = req.body;
    if (typeof req.body === 'string') {
      parsedBody = JSON.parse(req.body);
    }

    const { jobDescription, resume } = parsedBody || {};

    // Check both are provided
    if (!jobDescription || !resume) {
      return res.status(400).json({
        error: 'Please provide both job description and resume'
      });
    }

    // Call Groq API
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama3-70b-8192',
          messages: [
            {
              role: 'system',
              content: 'You are an expert interview coach with 10 years experience. Generate responses in JSON only.'
            },
            {
              role: 'user',
              content: `
                Job Description: ${jobDescription}

                Candidate Resume: ${resume}

                Generate exactly this JSON structure:
                {
                  "questions": [
                    {
                      "question": "interview question here",
                      "idealAnswer": "perfect answer based on resume",
                      "tip": "quick coaching tip"
                    }
                  ],
                  "weaknesses": ["area 1", "area 2", "area 3"],
                  "strengths": ["strength 1", "strength 2"]
                }

                Generate 8 questions. JSON only, no extra text.`
            }
          ],
          temperature: 0.7,
          max_tokens: 2000
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to fetch from Groq');
    }

    // Extract text safely
    const text = data.choices[0].message.content;

    // ROBUST FIX: Clean any variant of markdown code fences cleanly
    const cleaned = text.replace(/```json|```/gi, '').trim();
    const result = JSON.parse(cleaned);

    return res.status(200).json(result);

  } catch (error) {
    console.error('Server side crash log:', error.message);
    return res.status(500).json({
      error: 'Something went wrong',
      details: error.message
    });
  }
}
