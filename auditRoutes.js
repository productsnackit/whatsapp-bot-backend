/* =========================================================
    REFILL QUALITY AUDITS
    Refillers, locations, audit records (with photos) and CAPA tickets.
    Access: admin, plus employees in the Operations or Audit department.
========================================================= */

export const AUDIT_DEPARTMENTS = ["Operations", "Audit"];

// Initial roster and sites, inserted only when the tables are empty.
const SEED_REFILLERS = [
  ["Promod", "+91 9110623553", "Morning Shift", "Heavy Load", "Independent"],
  ["Karan Sharma", "+91 9771861157", "Morning Shift", "Heavy Load", "Independent"],
  ["Raman", "+91 8002552730", "Morning Shift", "Heavy Load", "Independent"],
  ["Nitish", "+91 7482892734", "Morning Shift", "Moderate", "Independent"],
  ["Manu", "+91 9054751339", "Morning Shift", "Moderate", "Independent"],
  ["Abbas", "+91 9955796828", "Morning Shift", "Moderate", "Independent"],
  ["Jitendar", "+91 6287200432", "Morning Shift", "Moderate", "Independent"],
  ["Karan R", "+91 7050385226", "Morning Shift", "Moderate", "CRED Shared Team"],
  ["Harish", "+91 9164370472", "Dedicated Hub", "Nutanix Hub", "Manoj, Rahul, Vishnu, Vijay"],
  ["Rahul", "+91 8002552730", "Dedicated Hub", "ZF Hub", "Independent"],
  ["Akash", "+91 6205335167", "Hub Support", "CRED Specialist", "CRED Shared Team"],
];

const SEED_LOCATIONS = {
  Promod: ["NT3", "Strides - 2", "Strides - 1", "Paychex Primco", "Paychex Vista", "Call Hub", "Fortis", "Bluebrich", "Fleek", "Amagi", "Greaves New", "Graves old"],
  Abbas: ["Bitgo", "Nes", "Hostel MI", "NI", "Smart stream", "NT1", "NT 4"],
  Nitish: ["Securanix", "Alorica nitish", "Pixxel", "PWC (Bagmane)", "Sila decathlon", "NT 2", "NT 5", "Caterpiller", "Solera"],
  "Karan Sharma": ["Stonex", "ODA", "RRI", "Sangrila", "Millennial Hostel (vasanth nagar)", "Millennial Hostel (Mysur Road)", "Alorica (Mysure Road)", "Lewis", "clicktech", "Enerpac", "Spain Io"],
  Raman: ["UI path (onex)", "Alorica Sachin", "Sony(Average sales)", "Point 72", "Awfis ebay (less sales)", "Micron", "BDO", "Polaris", "ODA (Raman)", "Refyne (less sales)"],
  Jitendar: ["Devrev", "Pwc", "SBS", "Opentext", "Anthropic"],
  Manu: ["SCB", "Mouser 1 and 2", "Oberoi", "Natural Remedies", "ittiam", "Acer", "Book my show", "Mother India"],
  "Karan R": ["Fluck", "Techtronix", "CRED", "Newtap"],
  Harish: ["Nutanix"],
  Rahul: ["ZF"],
};
const SEED_LOCATION_SUPPORT = { CRED: "Saroj, Akash", Nutanix: "Manoj, Rahul, Vishnu, Vijay" };

const MAX_PHOTOS = 4;

async function ensureAuditTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_refillers (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, phone TEXT, shift TEXT, workload TEXT, support TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_locations (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      refiller_id INTEGER REFERENCES audit_refillers(id) ON DELETE SET NULL,
      support TEXT, machine_code TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS audits (
      id SERIAL PRIMARY KEY, ref TEXT UNIQUE, location TEXT NOT NULL, machine_code TEXT,
      refiller TEXT, refiller_phone TEXT, auditor TEXT, created_by TEXT, scope TEXT NOT NULL,
      percentage INTEGER NOT NULL, earned_points INTEGER NOT NULL, total_points INTEGER NOT NULL,
      critical_breach BOOLEAN DEFAULT FALSE, checklist JSONB DEFAULT '[]'::jsonb,
      expiry_items JSONB DEFAULT '[]'::jsonb, photos JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_capa (
      id SERIAL PRIMARY KEY, ref TEXT UNIQUE, audit_id INTEGER REFERENCES audits(id) ON DELETE CASCADE,
      location TEXT, refiller TEXT, severity TEXT, defect TEXT, status TEXT DEFAULT 'OPEN',
      resolved_by TEXT, resolved_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const refillerCount = await db.query("SELECT COUNT(*)::int AS count FROM audit_refillers");
  if (refillerCount.rows[0].count === 0) {
    for (const [name, phone, shift, workload, support] of SEED_REFILLERS) {
      await db.query(
        "INSERT INTO audit_refillers (name, phone, shift, workload, support) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING",
        [name, phone, shift, workload, support]
      );
    }
  }

  const locationCount = await db.query("SELECT COUNT(*)::int AS count FROM audit_locations");
  if (locationCount.rows[0].count === 0) {
    for (const [refiller, sites] of Object.entries(SEED_LOCATIONS)) {
      for (const site of sites) {
        await db.query(
          "INSERT INTO audit_locations (name, refiller_id, support) VALUES ($1, (SELECT id FROM audit_refillers WHERE name=$2), $3) ON CONFLICT (name) DO NOTHING",
          [site, refiller, SEED_LOCATION_SUPPORT[site] || null]
        );
      }
    }
  }
}

function canAccessAudits(user) {
  return user?.role === "admin" || AUDIT_DEPARTMENTS.includes(user?.department);
}

function userName(user) {
  return user?.name || user?.username || "Admin";
}

// Recalculates the score on the server from the submitted checklist so saved results are consistent.
function scoreChecklist(items) {
  let earned = 0;
  let total = 0;
  let criticalBreach = false;
  for (const item of items) {
    const max = Math.max(0, Number(item.maxPts) || 0);
    const score = Number(item.score);
    if (score === -1) continue; // N/A
    const safeScore = Math.min(max, Math.max(0, Number.isFinite(score) ? score : 0));
    earned += safeScore;
    total += max;
    if (item.critical && safeScore === 0) criticalBreach = true;
  }
  const percentage = total > 0 ? Math.round((earned / total) * 100) : 100;
  return { earned, total, percentage, criticalBreach };
}

export function registerAuditRoutes(app, { db, auth, uploadImage }) {
  ensureAuditTables(db).catch((err) => console.log("AUDIT TABLES ERROR:", err.message));

  const guard = (req, res, next) => {
    if (!canAccessAudits(req.user)) return res.status(403).json({ error: "Audit access only" });
    next();
  };
  const adminOnly = (req, res, next) => {
    if (req.user?.role !== "admin") return res.status(403).json({ error: "Only admins can delete" });
    next();
  };
  const handle = (label, fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      console.log(`${label} ERROR:`, err.message);
      if (err.code === "23505") return res.status(409).json({ error: "That name already exists" });
      res.status(500).json({ error: "Server error" });
    }
  };

  /* ---------- Refillers ---------- */
  app.get("/audit/refillers", auth, guard, handle("AUDIT REFILLERS", async (req, res) => {
    const result = await db.query(`
      SELECT r.*, COUNT(l.id)::int AS site_count, COALESCE(json_agg(l.name ORDER BY l.name) FILTER (WHERE l.id IS NOT NULL), '[]') AS sites
      FROM audit_refillers r LEFT JOIN audit_locations l ON l.refiller_id = r.id
      GROUP BY r.id ORDER BY COUNT(l.id) DESC, r.name
    `);
    res.json(result.rows);
  }));

  const refillerFields = ["name", "phone", "shift", "workload", "support"];

  app.post("/audit/refillers", auth, guard, handle("AUDIT REFILLER CREATE", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Name is required" });
    const values = refillerFields.map((key) => (key === "name" ? name : req.body?.[key] || null));
    const result = await db.query(
      `INSERT INTO audit_refillers (${refillerFields.join(", ")}) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      values
    );
    res.status(201).json(result.rows[0]);
  }));

  app.patch("/audit/refillers/:id", auth, guard, handle("AUDIT REFILLER UPDATE", async (req, res) => {
    const fields = refillerFields.filter((key) => req.body?.[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    if (fields.includes("name") && !String(req.body.name).trim()) return res.status(400).json({ error: "Name is required" });
    const result = await db.query(
      `UPDATE audit_refillers SET ${fields.map((key, i) => `${key}=$${i + 1}`).join(", ")}, updated_at=NOW() WHERE id=$${fields.length + 1} RETURNING *`,
      [...fields.map((key) => (key === "name" ? String(req.body.name).trim() : req.body[key])), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Refiller not found" });
    res.json(result.rows[0]);
  }));

  app.delete("/audit/refillers/:id", auth, guard, adminOnly, handle("AUDIT REFILLER DELETE", async (req, res) => {
    await db.query("DELETE FROM audit_refillers WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  }));

  /* ---------- Locations ---------- */
  app.get("/audit/locations", auth, guard, handle("AUDIT LOCATIONS", async (req, res) => {
    const result = await db.query(`
      SELECT l.*, r.name AS refiller, r.phone AS refiller_phone
      FROM audit_locations l LEFT JOIN audit_refillers r ON r.id = l.refiller_id
      ORDER BY r.name NULLS LAST, l.name
    `);
    res.json(result.rows);
  }));

  const locationFields = ["name", "refiller_id", "support", "machine_code"];

  app.post("/audit/locations", auth, guard, handle("AUDIT LOCATION CREATE", async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Location name is required" });
    const result = await db.query(
      "INSERT INTO audit_locations (name, refiller_id, support, machine_code) VALUES ($1,$2,$3,$4) RETURNING *",
      [name, req.body?.refiller_id || null, req.body?.support || null, req.body?.machine_code || null]
    );
    res.status(201).json(result.rows[0]);
  }));

  app.patch("/audit/locations/:id", auth, guard, handle("AUDIT LOCATION UPDATE", async (req, res) => {
    const fields = locationFields.filter((key) => req.body?.[key] !== undefined);
    if (!fields.length) return res.status(400).json({ error: "No fields to update" });
    if (fields.includes("name") && !String(req.body.name).trim()) return res.status(400).json({ error: "Location name is required" });
    const values = fields.map((key) => (key === "refiller_id" ? req.body[key] || null : key === "name" ? String(req.body.name).trim() : req.body[key]));
    const result = await db.query(
      `UPDATE audit_locations SET ${fields.map((key, i) => `${key}=$${i + 1}`).join(", ")}, updated_at=NOW() WHERE id=$${fields.length + 1} RETURNING *`,
      [...values, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "Location not found" });
    res.json(result.rows[0]);
  }));

  app.delete("/audit/locations/:id", auth, guard, adminOnly, handle("AUDIT LOCATION DELETE", async (req, res) => {
    await db.query("DELETE FROM audit_locations WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  }));

  /* ---------- Audit records ---------- */
  app.get("/audits", auth, guard, handle("AUDITS", async (req, res) => {
    const result = await db.query("SELECT * FROM audits ORDER BY created_at DESC LIMIT 1000");
    res.json(result.rows);
  }));

  app.post("/audits", auth, guard, handle("AUDIT CREATE", async (req, res) => {
    const body = req.body || {};
    const location = String(body.location || "").trim();
    const scope = String(body.scope || "").trim();
    const checklist = Array.isArray(body.checklist) ? body.checklist : [];
    const expiryItems = Array.isArray(body.expiryItems) ? body.expiryItems : [];
    const photoData = Array.isArray(body.photos) ? body.photos.slice(0, MAX_PHOTOS) : [];

    if (!location) return res.status(400).json({ error: "Location is required" });
    if (!["daily", "weekly", "monthly"].includes(scope)) return res.status(400).json({ error: "Invalid audit scope" });
    if (!checklist.length) return res.status(400).json({ error: "Checklist is empty" });

    // Upload photos first so an audit is never saved with missing evidence.
    const photos = [];
    for (const photo of photoData) {
      if (typeof photo !== "string" || !photo.startsWith("data:image/")) continue;
      const url = await uploadImage(photo);
      if (!url) return res.status(502).json({ error: "Photo upload failed. Please try saving again." });
      photos.push(url);
    }

    const { earned, total, percentage, criticalBreach } = scoreChecklist(checklist);
    const inserted = await db.query(
      `INSERT INTO audits (location, machine_code, refiller, refiller_phone, auditor, created_by, scope, percentage, earned_points, total_points, critical_breach, checklist, expiry_items, photos)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        location, body.machineCode || null, body.refiller || null, body.refillerPhone || null,
        String(body.auditor || "").trim() || userName(req.user), userName(req.user), scope,
        percentage, earned, total, criticalBreach,
        JSON.stringify(checklist), JSON.stringify(expiryItems), JSON.stringify(photos),
      ]
    );
    const auditId = inserted.rows[0].id;
    const audit = await db.query(
      "UPDATE audits SET ref = 'AUD-' || LPAD(id::text, 5, '0') WHERE id=$1 RETURNING *",
      [auditId]
    );

    // One CAPA ticket per failed checklist point.
    for (const item of checklist) {
      if (Number(item.score) !== 0) continue;
      await db.query(
        `INSERT INTO audit_capa (audit_id, location, refiller, severity, defect) VALUES ($1,$2,$3,$4,$5)`,
        [auditId, location, body.refiller || null, item.critical ? "P1 - Critical SOP defect" : "P2 - Routine defect", `${item.text}${item.notes ? ` - ${item.notes}` : ""}`]
      );
    }
    await db.query("UPDATE audit_capa SET ref = 'CAPA-' || LPAD(id::text, 5, '0') WHERE ref IS NULL");

    res.status(201).json(audit.rows[0]);
  }));

  app.delete("/audits/:id", auth, guard, adminOnly, handle("AUDIT DELETE", async (req, res) => {
    await db.query("DELETE FROM audits WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  }));

  /* ---------- CAPA tickets ---------- */
  app.get("/audit/capa", auth, guard, handle("AUDIT CAPA", async (req, res) => {
    const result = await db.query(`
      SELECT c.*, a.ref AS audit_ref FROM audit_capa c LEFT JOIN audits a ON a.id = c.audit_id
      ORDER BY (c.status = 'OPEN') DESC, c.created_at DESC LIMIT 1000
    `);
    res.json(result.rows);
  }));

  app.patch("/audit/capa/:id", auth, guard, handle("AUDIT CAPA UPDATE", async (req, res) => {
    const status = String(req.body?.status || "").toUpperCase();
    if (!["OPEN", "RESOLVED"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    const result = await db.query(
      `UPDATE audit_capa SET status=$1,
         resolved_by = CASE WHEN $1 = 'RESOLVED' THEN $2 ELSE NULL END,
         resolved_at = CASE WHEN $1 = 'RESOLVED' THEN NOW() ELSE NULL END
       WHERE id=$3 RETURNING *`,
      [status, userName(req.user), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "CAPA ticket not found" });
    res.json(result.rows[0]);
  }));
}
