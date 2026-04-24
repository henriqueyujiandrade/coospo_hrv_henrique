import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { config, beats, metricas } = req.body;

  if (!config || !beats || !metricas) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

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

    return res.status(200).json({ ok: true, session_id: session.id });
  } catch (err) {
    console.error('[save-session]', err);
    return res.status(500).json({ error: err.message });
  }
}
