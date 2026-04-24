const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rows = await sql`
      SELECT id, config, beats, metricas, created_at
      FROM sessions
      ORDER BY created_at DESC
      LIMIT 50
    `;
    console.log('[get-sessions] sessões retornadas:', rows.length);
    return res.status(200).json({ sessions: rows });
  } catch (err) {
    console.error('[get-sessions] erro:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
