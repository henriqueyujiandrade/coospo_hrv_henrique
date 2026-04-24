const { neon } = require('@neondatabase/serverless');

let sql;
try {
  sql = neon(process.env.POSTGRES_URL);
  console.log('[save-session] conectado ao banco');
} catch (err) {
  console.error('[save-session] falha conectando ao banco:', err.message);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { config, beats, metricas } = req.body;

  if (!config || !beats || !metricas) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  console.log('[save-session] processando');

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id         SERIAL PRIMARY KEY,
        config     JSONB NOT NULL,
        beats      JSONB NOT NULL,
        metricas   JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    const { rows: [session] } = await sql`
      INSERT INTO sessions (config, beats, metricas)
      VALUES (
        ${JSON.stringify(config)},
        ${JSON.stringify(beats)},
        ${JSON.stringify(metricas)}
      )
      RETURNING id
    `;

    console.log('[save-session] dado salvo no banco. session_id:', session.id);
    return res.status(200).json({ ok: true, session_id: session.id });
  } catch (err) {
    console.error('[save-session] erro no banco:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
