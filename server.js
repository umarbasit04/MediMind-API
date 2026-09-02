const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const swaggerUi = require("swagger-ui-express");

const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.error("JWT_SECRET is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase and other hosted PostgreSQL providers require TLS in every environment.
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(cors({ origin: FRONTEND_URL || true }));
app.use(express.json({ limit: "1mb" }));

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

const sendData = (res, data, status = 200) => res.status(status).json({ data });
const sendError = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const validationError = (message) => new ApiError(400, "validation_error", message);
const requireValue = (value, name) => {
  if (value === undefined || value === null || value === "") {
    throw validationError(`${name} is required`);
  }
};

const isUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const isDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const isTime = (value) => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const isEmail = (value) =>
  typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const dateShape = (value) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
};

function validateDays(days) {
  if (!Array.isArray(days) || days.length < 1 || days.length > 7) {
    throw validationError("days_of_week must contain 1 to 7 days");
  }
  if (
    new Set(days).size !== days.length ||
    days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  ) {
    throw validationError("days_of_week must contain unique integers from 1 to 7");
  }
  return days.slice().sort((a, b) => a - b);
}

function validateMedicineBody(body, { partial = false } = {}) {
  const value = body && typeof body === "object" ? body : {};
  if (!partial || value.name !== undefined) {
    requireValue(value.name, "name");
    if (typeof value.name !== "string" || value.name.trim().length > 200) {
      throw validationError("name must be a non-empty string of 200 characters or fewer");
    }
  }
  if (!partial || value.dosage !== undefined) {
    requireValue(value.dosage, "dosage");
    if (typeof value.dosage !== "string" || value.dosage.trim().length > 100) {
      throw validationError("dosage must be a non-empty string of 100 characters or fewer");
    }
  }
  if (value.form !== undefined) {
    if (
      typeof value.form !== "string" ||
      !["tablet", "capsule", "syrup", "injection", "drops", "other"].includes(value.form)
    ) {
      throw validationError("form is invalid");
    }
  }
  if (value.frequency_per_day !== undefined) {
    if (
      !Number.isInteger(value.frequency_per_day) ||
      value.frequency_per_day < 1 ||
      value.frequency_per_day > 10
    ) {
      throw validationError("frequency_per_day must be an integer between 1 and 10");
    }
  }
  for (const field of ["start_date", "end_date"]) {
    if (value[field] !== undefined && value[field] !== null && !isDate(value[field])) {
      throw validationError(`${field} must be YYYY-MM-DD`);
    }
  }
  if (
    value.start_date &&
    value.end_date &&
    value.end_date < value.start_date
  ) {
    throw validationError("end_date must be on or after start_date");
  }
  if (value.instructions !== undefined && value.instructions !== null && typeof value.instructions !== "string") {
    throw validationError("instructions must be a string or null");
  }
  if (value.reminder_times !== undefined) {
    if (
      !Array.isArray(value.reminder_times) ||
      value.reminder_times.length < 1 ||
      value.reminder_times.length > 10 ||
      value.reminder_times.some((time) => !isTime(time))
    ) {
      throw validationError("reminder_times must contain valid HH:MM times");
    }
    if (new Set(value.reminder_times).size !== value.reminder_times.length) {
      throw validationError("reminder_times must not contain duplicates");
    }
  } else if (!partial) {
    throw validationError("reminder_times is required");
  }
  let days_of_week;
  if (value.days_of_week !== undefined) {
    days_of_week = validateDays(value.days_of_week);
  } else if (!partial) {
    throw validationError("days_of_week is required");
  }
  return { ...value, days_of_week };
}

function userShape(row) {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone ?? null,
    date_of_birth: dateShape(row.date_of_birth),
    profile_picture_url: row.profile_picture_url ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

function timeShape(value) {
  return String(value).slice(0, 5);
}

function medicineShape(row, reminders) {
  return {
    id: row.id,
    name: row.name,
    dosage: row.dosage,
    form: row.form,
    frequency_per_day: row.frequency_per_day,
    start_date: dateShape(row.start_date),
    end_date: dateShape(row.end_date),
    instructions: row.instructions ?? null,
    is_active: row.is_active,
    reminders: (reminders || []).map(reminderShape),
  };
}

function reminderShape(row) {
  return {
    id: row.id,
    time_of_day: timeShape(row.time_of_day),
    days_of_week: row.days_of_week,
    is_enabled: row.is_enabled,
  };
}

function logShape(row) {
  return {
    id: row.id,
    reminder_id: row.reminder_id,
    medicine_id: row.medicine_id,
    scheduled_at: new Date(row.scheduled_at).toISOString(),
    taken_at: row.taken_at ? new Date(row.taken_at).toISOString() : null,
    status: row.status,
    note: row.note ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

async function getMedicineWithReminders(client, userId, medicineId, includeInactive = true) {
  const medicineResult = await client.query(
    `SELECT * FROM medicines
     WHERE id = $1 AND user_id = $2 ${includeInactive ? "" : "AND is_active = true"}`,
    [medicineId, userId],
  );
  if (!medicineResult.rows[0]) throw new ApiError(404, "not_found", "Medicine not found");
  const reminders = await client.query(
    `SELECT * FROM reminders WHERE medicine_id = $1 AND user_id = $2 ORDER BY time_of_day, created_at`,
    [medicineId, userId],
  );
  return medicineShape(medicineResult.rows[0], reminders.rows);
}

function authMiddleware(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return sendError(res, 401, "unauthorized", "A Bearer token is required");
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.sub || !isUuid(payload.sub)) throw new Error("invalid subject");
    req.userId = payload.sub;
    next();
  } catch {
    return sendError(res, 401, "unauthorized", "The token is invalid or expired");
  }
}

async function findUser(userId) {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
  return result.rows[0];
}

function issueToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "7d" });
}

app.get("/health", (_req, res) => sendData(res, { status: "ok" }));

app.post(
  "/api/auth/register",
  asyncHandler(async (req, res) => {
    const { full_name, email, password } = req.body || {};
    requireValue(full_name, "full_name");
    requireValue(email, "email");
    requireValue(password, "password");
    if (typeof full_name !== "string" || full_name.trim().length < 1 || full_name.trim().length > 200) {
      throw validationError("full_name must be 1 to 200 characters");
    }
    if (!isEmail(email)) throw validationError("email must be valid");
    if (typeof password !== "string" || password.length < 8) {
      throw validationError("password must be at least 8 characters");
    }
    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const result = await pool.query(
        `INSERT INTO users (full_name, email, password_hash)
         VALUES ($1, $2, $3) RETURNING *`,
        [full_name.trim(), normalizedEmail, passwordHash],
      );
      const user = userShape(result.rows[0]);
      sendData(res, { user, token: issueToken(user.id) }, 201);
    } catch (error) {
      if (error.code === "23505") throw new ApiError(409, "email_taken", "Email is already registered");
      throw error;
    }
  }),
);

app.post(
  "/api/auth/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    requireValue(email, "email");
    requireValue(password, "password");
    if (!isEmail(email)) throw validationError("email must be valid");
    if (typeof password !== "string") throw validationError("password must be a string");
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.trim().toLowerCase()]);
    const userRow = result.rows[0];
    if (!userRow || !(await bcrypt.compare(password, userRow.password_hash))) {
      throw new ApiError(401, "wrong_credentials", "Email or password is incorrect");
    }
    sendData(res, { user: userShape(userRow), token: issueToken(userRow.id) });
  }),
);

app.get(
  "/api/auth/me",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const row = await findUser(req.userId);
    if (!row) throw new ApiError(401, "unauthorized", "User no longer exists");
    sendData(res, { user: userShape(row) });
  }),
);

app.get(
  "/api/profile",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const row = await findUser(req.userId);
    if (!row) throw new ApiError(404, "not_found", "User not found");
    sendData(res, { user: userShape(row) });
  }),
);

app.put(
  "/api/profile",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const allowed = ["full_name", "phone", "date_of_birth"];
    const body = req.body || {};
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
    if (unknown.length || !Object.keys(body).length) throw validationError("Only profile fields may be updated");
    if (body.full_name !== undefined && (typeof body.full_name !== "string" || !body.full_name.trim())) {
      throw validationError("full_name must be a non-empty string");
    }
    if (body.phone !== undefined && body.phone !== null && typeof body.phone !== "string") {
      throw validationError("phone must be a string or null");
    }
    if (body.date_of_birth !== undefined && body.date_of_birth !== null && !isDate(body.date_of_birth)) {
      throw validationError("date_of_birth must be YYYY-MM-DD or null");
    }
    const current = await findUser(req.userId);
    if (!current) throw new ApiError(404, "not_found", "User not found");
    const result = await pool.query(
      `UPDATE users SET
         full_name = COALESCE($1, full_name),
         phone = CASE WHEN $2::boolean THEN $3 ELSE phone END,
         date_of_birth = CASE WHEN $4::boolean THEN $5::date ELSE date_of_birth END,
         updated_at = now()
       WHERE id = $6 RETURNING *`,
      [
        body.full_name === undefined ? null : body.full_name.trim(),
        body.phone !== undefined,
        body.phone ?? null,
        body.date_of_birth !== undefined,
        body.date_of_birth ?? null,
        req.userId,
      ],
    );
    sendData(res, { user: userShape(result.rows[0]) });
  }),
);

app.get(
  "/api/medicines",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const values = [req.userId];
    const conditions = ["m.user_id = $1"];
    if (req.query.search !== undefined) {
      if (typeof req.query.search !== "string" || req.query.search.length > 100) {
        throw validationError("search must be a string of 100 characters or fewer");
      }
      values.push(`%${req.query.search}%`);
      conditions.push(`m.name ILIKE $${values.length}`);
    }
    if (req.query.active !== undefined) {
      if (!["true", "false"].includes(req.query.active)) throw validationError("active must be true or false");
      values.push(req.query.active === "true");
      conditions.push(`m.is_active = $${values.length}`);
    }
    const medicines = await pool.query(
      `SELECT m.* FROM medicines m WHERE ${conditions.join(" AND ")} ORDER BY m.created_at DESC`,
      values,
    );
    const output = await Promise.all(
      medicines.rows.map((row) => getMedicineWithReminders(pool, req.userId, row.id)),
    );
    sendData(res, output);
  }),
);

app.post(
  "/api/medicines",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const body = validateMedicineBody(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const medicineResult = await client.query(
        `INSERT INTO medicines
         (user_id, name, dosage, form, frequency_per_day, start_date, end_date, instructions)
         VALUES ($1, $2, $3, COALESCE($4, 'tablet'), COALESCE($5, 1), COALESCE($6, current_date), $7, $8)
         RETURNING *`,
        [
          req.userId,
          body.name.trim(),
          body.dosage.trim(),
          body.form ?? null,
          body.frequency_per_day ?? null,
          body.start_date ?? null,
          body.end_date ?? null,
          body.instructions ?? null,
        ],
      );
      const medicine = medicineResult.rows[0];
      for (const time of body.reminder_times) {
        await client.query(
          `INSERT INTO reminders (medicine_id, user_id, time_of_day, days_of_week)
           VALUES ($1, $2, $3::time, $4)`,
          [medicine.id, req.userId, time, body.days_of_week],
        );
      }
      await client.query("COMMIT");
      sendData(res, await getMedicineWithReminders(pool, req.userId, medicine.id), 201);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

app.get(
  "/api/medicines/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Medicine not found");
    sendData(res, await getMedicineWithReminders(pool, req.userId, req.params.id));
  }),
);

app.put(
  "/api/medicines/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Medicine not found");
    const body = validateMedicineBody(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE medicines SET name=$1, dosage=$2, form=COALESCE($3, form),
           frequency_per_day=COALESCE($4, frequency_per_day), start_date=COALESCE($5, start_date),
           end_date=$6, instructions=$7
         WHERE id=$8 AND user_id=$9 RETURNING *`,
        [
          body.name.trim(),
          body.dosage.trim(),
          body.form ?? null,
          body.frequency_per_day ?? null,
          body.start_date ?? null,
          body.end_date ?? null,
          body.instructions ?? null,
          req.params.id,
          req.userId,
        ],
      );
      if (!result.rows[0]) throw new ApiError(404, "not_found", "Medicine not found");
      await client.query("DELETE FROM reminders WHERE medicine_id=$1 AND user_id=$2", [
        req.params.id,
        req.userId,
      ]);
      for (const time of body.reminder_times) {
        await client.query(
          `INSERT INTO reminders (medicine_id, user_id, time_of_day, days_of_week)
           VALUES ($1, $2, $3::time, $4)`,
          [req.params.id, req.userId, time, body.days_of_week],
        );
      }
      await client.query("COMMIT");
      sendData(res, await getMedicineWithReminders(pool, req.userId, req.params.id));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

app.delete(
  "/api/medicines/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Medicine not found");
    const result = await pool.query(
      "UPDATE medicines SET is_active=false WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Medicine not found");
    sendData(res, { id: result.rows[0].id });
  }),
);

function localTodayParts() {
  const now = new Date();
  const day = now.getUTCDay() || 7;
  const date = now.toISOString().slice(0, 10);
  return { now, day, date };
}

app.get(
  "/api/reminders/today",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { now, day, date } = localTodayParts();
    const result = await pool.query(
      `SELECT r.id AS reminder_id, r.medicine_id, m.name AS medicine_name, m.dosage,
              r.time_of_day, l.id AS log_id, l.status AS log_status
       FROM reminders r
       JOIN medicines m ON m.id=r.medicine_id AND m.user_id=r.user_id
       LEFT JOIN adherence_logs l ON l.reminder_id=r.id AND l.user_id=r.user_id
         AND l.scheduled_at >= $2::date
         AND l.scheduled_at < ($2::date + interval '1 day')
       WHERE r.user_id=$1 AND m.is_active=true AND r.is_enabled=true
         AND m.start_date <= $2::date AND (m.end_date IS NULL OR m.end_date >= $2::date)
         AND $3 = ANY(r.days_of_week)
       ORDER BY r.time_of_day`,
      [req.userId, date, day],
    );
    const items = result.rows.map((row) => {
      const time = timeShape(row.time_of_day);
      const scheduled = new Date(`${date}T${time}:00.000Z`);
      const status = row.log_status || (scheduled.getTime() < now.getTime() ? "missed" : "pending");
      return {
        reminder_id: row.reminder_id,
        medicine_id: row.medicine_id,
        medicine_name: row.medicine_name,
        dosage: row.dosage,
        time_of_day: time,
        status,
        log_id: row.log_id || null,
      };
    });
    sendData(res, items);
  }),
);

app.get(
  "/api/reminders",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT r.*, m.name AS medicine_name, m.dosage
       FROM reminders r JOIN medicines m ON m.id=r.medicine_id
       WHERE r.user_id=$1 ORDER BY r.time_of_day, r.created_at`,
      [req.userId],
    );
    sendData(
      res,
      result.rows.map((row) => ({
        ...reminderShape(row),
        medicine_id: row.medicine_id,
        medicine_name: row.medicine_name,
        dosage: row.dosage,
      })),
    );
  }),
);

app.post(
  "/api/reminders",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { medicine_id, time_of_day, days_of_week } = req.body || {};
    requireValue(medicine_id, "medicine_id");
    requireValue(time_of_day, "time_of_day");
    if (!isUuid(medicine_id) || !isTime(time_of_day)) throw validationError("medicine_id or time_of_day is invalid");
    const days = validateDays(days_of_week);
    const medicine = await pool.query(
      "SELECT id FROM medicines WHERE id=$1 AND user_id=$2 AND is_active=true",
      [medicine_id, req.userId],
    );
    if (!medicine.rows[0]) throw new ApiError(404, "not_found", "Medicine not found");
    const result = await pool.query(
      `INSERT INTO reminders (medicine_id, user_id, time_of_day, days_of_week)
       VALUES ($1, $2, $3::time, $4) RETURNING *`,
      [medicine_id, req.userId, time_of_day, days],
    );
    sendData(res, reminderShape(result.rows[0]), 201);
  }),
);

app.put(
  "/api/reminders/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Reminder not found");
    const body = req.body || {};
    if (body.time_of_day === undefined && body.is_enabled === undefined) {
      throw validationError("time_of_day or is_enabled is required");
    }
    if (body.time_of_day !== undefined && !isTime(body.time_of_day)) throw validationError("time_of_day must be HH:MM");
    if (body.is_enabled !== undefined && typeof body.is_enabled !== "boolean") throw validationError("is_enabled must be boolean");
    const result = await pool.query(
      `UPDATE reminders SET time_of_day=COALESCE($1::time, time_of_day),
         is_enabled=COALESCE($2, is_enabled)
       WHERE id=$3 AND user_id=$4 RETURNING *`,
      [body.time_of_day ?? null, body.is_enabled ?? null, req.params.id, req.userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Reminder not found");
    sendData(res, reminderShape(result.rows[0]));
  }),
);

app.delete(
  "/api/reminders/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Reminder not found");
    const result = await pool.query(
      "DELETE FROM reminders WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Reminder not found");
    sendData(res, { id: result.rows[0].id });
  }),
);

app.post(
  "/api/adherence/:reminder_id/mark",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { reminder_id } = req.params;
    const { status, note } = req.body || {};
    if (!isUuid(reminder_id) || !["taken", "skipped"].includes(status)) {
      throw validationError("reminder_id and status (taken or skipped) are required");
    }
    if (note !== undefined && note !== null && typeof note !== "string") throw validationError("note must be a string or null");
    const { day, date } = localTodayParts();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const reminder = await client.query(
        `SELECT r.*, m.id AS med_id FROM reminders r
         JOIN medicines m ON m.id=r.medicine_id
         WHERE r.id=$1 AND r.user_id=$2 AND m.is_active=true AND $3=ANY(r.days_of_week)
           AND m.start_date <= $4::date AND (m.end_date IS NULL OR m.end_date >= $4::date)`,
        [reminder_id, req.userId, day, date],
      );
      if (!reminder.rows[0]) throw new ApiError(404, "not_found", "Today's reminder not found");
      const row = reminder.rows[0];
      const result = await client.query(
        `INSERT INTO adherence_logs
          (reminder_id, medicine_id, user_id, scheduled_at, taken_at, status, note)
         VALUES ($1, $2, $3, ($4::date + $5::time)::timestamptz,
                 CASE WHEN $6='taken' THEN now() ELSE NULL END, $6, $7)
         ON CONFLICT (reminder_id, scheduled_at)
         DO UPDATE SET taken_at=EXCLUDED.taken_at, status=EXCLUDED.status, note=EXCLUDED.note
         RETURNING id AS log_id, status, taken_at`,
        [reminder_id, row.medicine_id, req.userId, date, timeShape(row.time_of_day), status, note ?? null],
      );
      await client.query("COMMIT");
      const log = result.rows[0];
      sendData(res, {
        log_id: log.log_id,
        status: log.status,
        taken_at: log.taken_at ? new Date(log.taken_at).toISOString() : null,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

app.get(
  "/api/adherence/history",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const from = req.query.from;
    const to = req.query.to;
    if (from !== undefined && !isDate(from)) throw validationError("from must be YYYY-MM-DD");
    if (to !== undefined && !isDate(to)) throw validationError("to must be YYYY-MM-DD");
    if (from && to && from > to) throw validationError("from must be on or before to");
    const values = [req.userId];
    const conditions = ["user_id=$1"];
    if (from) {
      values.push(from);
      conditions.push(`scheduled_at >= $${values.length}::date`);
    }
    if (to) {
      values.push(to);
      conditions.push(`scheduled_at < ($${values.length}::date + interval '1 day')`);
    }
    const result = await pool.query(
      `SELECT * FROM adherence_logs WHERE ${conditions.join(" AND ")} ORDER BY scheduled_at DESC`,
      values,
    );
    sendData(res, result.rows.map(logShape));
  }),
);

app.get(
  "/api/adherence/stats",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='taken')::int AS taken,
         COUNT(*) FILTER (WHERE status='missed')::int AS missed,
         COUNT(*) FILTER (WHERE status='skipped')::int AS skipped,
         COUNT(*) FILTER (WHERE status IN ('taken','missed','skipped'))::int AS completed
       FROM adherence_logs WHERE user_id=$1`,
      [req.userId],
    );
    const stats = result.rows[0];
    const completed = Number(stats.completed);
    const taken = Number(stats.taken);
    const days = await pool.query(
      `SELECT scheduled_at::date AS date
       FROM adherence_logs WHERE user_id=$1 AND status='taken'
       GROUP BY scheduled_at::date ORDER BY date DESC`,
      [req.userId],
    );
    let streak = 0;
    let expected = new Date();
    for (const row of days.rows) {
      const date = dateShape(row.date);
      const expectedDate = expected.toISOString().slice(0, 10);
      if (date === expectedDate) {
        streak += 1;
        expected.setUTCDate(expected.getUTCDate() - 1);
      } else if (date < expectedDate) {
        break;
      }
    }
    sendData(res, {
      taken,
      missed: Number(stats.missed),
      skipped: Number(stats.skipped),
      rate_percent: completed ? Math.round((taken / completed) * 100) : 0,
      streak_days: streak,
    });
  }),
);

function validateContact(body) {
  const { name, phone, relation, is_primary } = body || {};
  requireValue(name, "name");
  requireValue(phone, "phone");
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw validationError("name is invalid");
  if (typeof phone !== "string" || !phone.trim() || phone.length > 50) throw validationError("phone is invalid");
  if (relation !== undefined && relation !== null && typeof relation !== "string") throw validationError("relation must be a string or null");
  if (is_primary !== undefined && typeof is_primary !== "boolean") throw validationError("is_primary must be boolean");
  return { name: name.trim(), phone: phone.trim(), relation: relation ?? null, is_primary: is_primary ?? false };
}

app.get(
  "/api/emergency-contacts",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      "SELECT id, name, phone, relation, is_primary, created_at FROM emergency_contacts WHERE user_id=$1 ORDER BY is_primary DESC, created_at",
      [req.userId],
    );
    sendData(res, result.rows);
  }),
);

app.post(
  "/api/emergency-contacts",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const contact = validateContact(req.body);
    const result = await pool.query(
      `INSERT INTO emergency_contacts (user_id, name, phone, relation, is_primary)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, name, phone, relation, is_primary, created_at`,
      [req.userId, contact.name, contact.phone, contact.relation, contact.is_primary],
    );
    sendData(res, result.rows[0], 201);
  }),
);

app.put(
  "/api/emergency-contacts/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Emergency contact not found");
    const contact = validateContact(req.body);
    const result = await pool.query(
      `UPDATE emergency_contacts SET name=$1, phone=$2, relation=$3, is_primary=$4
       WHERE id=$5 AND user_id=$6
       RETURNING id, name, phone, relation, is_primary, created_at`,
      [contact.name, contact.phone, contact.relation, contact.is_primary, req.params.id, req.userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Emergency contact not found");
    sendData(res, result.rows[0]);
  }),
);

app.delete(
  "/api/emergency-contacts/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Emergency contact not found");
    const result = await pool.query(
      "DELETE FROM emergency_contacts WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Emergency contact not found");
    sendData(res, { id: result.rows[0].id });
  }),
);

app.post(
  "/api/sos",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { note } = req.body || {};
    if (note !== undefined && note !== null && typeof note !== "string") throw validationError("note must be a string or null");
    const contacts = await pool.query(
      "SELECT name, phone, relation FROM emergency_contacts WHERE user_id=$1 ORDER BY is_primary DESC, created_at",
      [req.userId],
    );
    console.log(JSON.stringify({ event: "sos", user_id: req.userId, note: note ?? null, at: new Date().toISOString() }));
    sendData(res, { message: "Emergency contacts ready", contacts: contacts.rows });
  }),
);

function validateFamily(body) {
  const { name, relation, phone, email, can_view_adherence } = body || {};
  requireValue(name, "name");
  if (typeof name !== "string" || !name.trim() || name.length > 200) throw validationError("name is invalid");
  for (const field of ["relation", "phone", "email"]) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") {
      throw validationError(`${field} must be a string or null`);
    }
  }
  if (email && !isEmail(email)) throw validationError("email must be valid");
  if (can_view_adherence !== undefined && typeof can_view_adherence !== "boolean") throw validationError("can_view_adherence must be boolean");
  return { name: name.trim(), relation: relation ?? null, phone: phone ?? null, email: email ?? null, can_view_adherence: can_view_adherence ?? false };
}

app.get(
  "/api/family-members",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      "SELECT id, name, relation, email, phone, can_view_adherence, created_at FROM family_members WHERE user_id=$1 ORDER BY created_at",
      [req.userId],
    );
    sendData(res, result.rows);
  }),
);

app.post(
  "/api/family-members",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const member = validateFamily(req.body);
    const result = await pool.query(
      `INSERT INTO family_members (user_id, name, relation, email, phone, can_view_adherence)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, name, relation, email, phone, can_view_adherence, created_at`,
      [req.userId, member.name, member.relation, member.email, member.phone, member.can_view_adherence],
    );
    sendData(res, result.rows[0], 201);
  }),
);

app.put(
  "/api/family-members/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Family member not found");
    const member = validateFamily(req.body);
    const result = await pool.query(
      `UPDATE family_members SET name=$1, relation=$2, email=$3, phone=$4, can_view_adherence=$5
       WHERE id=$6 AND user_id=$7
       RETURNING id, name, relation, email, phone, can_view_adherence, created_at`,
      [member.name, member.relation, member.email, member.phone, member.can_view_adherence, req.params.id, req.userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Family member not found");
    sendData(res, result.rows[0]);
  }),
);

app.delete(
  "/api/family-members/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id)) throw new ApiError(404, "not_found", "Family member not found");
    const result = await pool.query(
      "DELETE FROM family_members WHERE id=$1 AND user_id=$2 RETURNING id",
      [req.params.id, req.userId],
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Family member not found");
    sendData(res, { id: result.rows[0].id });
  }),
);

const swaggerDocument = {
  openapi: "3.0.3",
  info: { title: "MediMind API", version: "1.0.0", description: "Medication adherence REST API" },
  servers: [{ url: "/" }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: { 200: { description: "OK" } },
      },
    },
    "/api/auth/register": {
      post: {
        summary: "Register",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Register" },
              example: {
                full_name: "Ayesha Khan",
                email: "ayesha.khan@example.com",
                password: "SafePassword123!",
              },
            },
          },
        },
        responses: {
          201: {
            description: "Registered",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } },
          },
        },
      },
    },
    "/api/auth/login": {
      post: {
        summary: "Login",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Login" },
              example: { email: "ayesha.khan@example.com", password: "SafePassword123!" },
            },
          },
        },
        responses: {
          200: {
            description: "Logged in",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } },
          },
        },
      },
    },
    "/api/auth/me": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "Current user",
        responses: {
          200: {
            description: "User",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UserResponse" } } },
          },
        },
      },
    },
    "/api/profile": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "Get profile",
        responses: {
          200: {
            description: "Profile",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UserResponse" } } },
          },
        },
      },
      put: {
        security: [{ bearerAuth: [] }],
        summary: "Update profile",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ProfileUpdate" },
              example: { full_name: "Ayesha Khan", phone: "+92 300 1234567", date_of_birth: "1995-06-15" },
            },
          },
        },
        responses: {
          200: {
            description: "Profile",
            content: { "application/json": { schema: { $ref: "#/components/schemas/UserResponse" } } },
          },
        },
      },
    },
    "/api/medicines": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "List medicines",
        responses: { 200: { description: "Medicines" } },
      },
      post: {
        security: [{ bearerAuth: [] }],
        summary: "Add medicine",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MedicineInput" },
              example: {
                name: "Amoxicillin",
                dosage: "500 mg",
                form: "capsule",
                frequency_per_day: 3,
                start_date: "2026-09-03",
                end_date: "2026-09-10",
                instructions: "Take after food",
                reminder_times: ["08:00", "14:00", "20:00"],
                days_of_week: [1, 2, 3, 4, 5, 6, 7],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Medicine",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MedicineResponse" } } },
          },
        },
      },
    },
    "/api/medicines/{id}": {
      parameters: [{ $ref: "#/components/parameters/id" }],
      get: {
        security: [{ bearerAuth: [] }],
        summary: "Get medicine",
        responses: {
          200: {
            description: "Medicine",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MedicineResponse" } } },
          },
        },
      },
      put: {
        security: [{ bearerAuth: [] }],
        summary: "Replace medicine",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/MedicineInput" },
              example: {
                name: "Amoxicillin",
                dosage: "500 mg",
                form: "capsule",
                frequency_per_day: 3,
                start_date: "2026-09-03",
                end_date: "2026-09-10",
                instructions: "Take after food",
                reminder_times: ["08:00", "14:00", "20:00"],
                days_of_week: [1, 2, 3, 4, 5, 6, 7],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Medicine",
            content: { "application/json": { schema: { $ref: "#/components/schemas/MedicineResponse" } } },
          },
        },
      },
      delete: {
        security: [{ bearerAuth: [] }],
        summary: "Archive medicine",
        responses: { 200: { description: "Archived" } },
      },
    },
    "/api/reminders/today": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "Today's reminder dashboard",
        responses: { 200: { description: "Today items" } },
      },
    },
    "/api/reminders": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "List reminders",
        responses: { 200: { description: "Reminders" } },
      },
      post: {
        security: [{ bearerAuth: [] }],
        summary: "Add reminder",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReminderInput" },
              example: {
                medicine_id: "550e8400-e29b-41d4-a716-446655440000",
                time_of_day: "08:00",
                days_of_week: [1, 2, 3, 4, 5, 6, 7],
              },
            },
          },
        },
        responses: {
          201: {
            description: "Reminder",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ReminderResponse" } } },
          },
        },
      },
    },
    "/api/reminders/{id}": {
      parameters: [{ $ref: "#/components/parameters/id" }],
      put: {
        security: [{ bearerAuth: [] }],
        summary: "Update reminder",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ReminderUpdate" },
              example: { time_of_day: "09:30", is_enabled: true },
            },
          },
        },
        responses: {
          200: {
            description: "Reminder",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ReminderResponse" } } },
          },
        },
      },
      delete: {
        security: [{ bearerAuth: [] }],
        summary: "Delete reminder",
        responses: { 200: { description: "Deleted" } },
      },
    },
    "/api/adherence/{reminder_id}/mark": {
      parameters: [{ $ref: "#/components/parameters/reminderId" }],
      post: {
        security: [{ bearerAuth: [] }],
        summary: "Mark today's dose",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AdherenceMarkInput" },
              example: { status: "taken", note: "Taken with breakfast" },
            },
          },
        },
        responses: {
          200: {
            description: "Adherence log",
            content: { "application/json": { schema: { $ref: "#/components/schemas/AdherenceMarkResponse" } } },
          },
        },
      },
    },
    "/api/adherence/history": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "Adherence history",
        responses: { 200: { description: "Logs" } },
      },
    },
    "/api/adherence/stats": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "Adherence statistics",
        responses: { 200: { description: "Stats" } },
      },
    },
    "/api/emergency-contacts": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "List emergency contacts",
        responses: { 200: { description: "Contacts" } },
      },
      post: {
        security: [{ bearerAuth: [] }],
        summary: "Add emergency contact",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ContactInput" },
              example: {
                name: "Imran Khan",
                phone: "+92 300 7654321",
                relation: "Brother",
                is_primary: true,
              },
            },
          },
        },
        responses: {
          201: {
            description: "Contact",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ContactResponse" } } },
          },
        },
      },
    },
    "/api/emergency-contacts/{id}": {
      parameters: [{ $ref: "#/components/parameters/id" }],
      put: {
        security: [{ bearerAuth: [] }],
        summary: "Update contact",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ContactInput" },
              example: {
                name: "Imran Khan",
                phone: "+92 300 7654321",
                relation: "Brother",
                is_primary: true,
              },
            },
          },
        },
        responses: {
          200: {
            description: "Contact",
            content: { "application/json": { schema: { $ref: "#/components/schemas/ContactResponse" } } },
          },
        },
      },
      delete: {
        security: [{ bearerAuth: [] }],
        summary: "Delete contact",
        responses: { 200: { description: "Deleted" } },
      },
    },
    "/api/sos": {
      post: {
        security: [{ bearerAuth: [] }],
        summary: "Prepare SOS contacts",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SosInput" },
              example: { note: "I need urgent assistance" },
            },
          },
        },
        responses: {
          200: {
            description: "SOS contacts",
            content: { "application/json": { schema: { $ref: "#/components/schemas/SosResponse" } } },
          },
        },
      },
    },
    "/api/family-members": {
      get: {
        security: [{ bearerAuth: [] }],
        summary: "List family members",
        responses: { 200: { description: "Family members" } },
      },
      post: {
        security: [{ bearerAuth: [] }],
        summary: "Add family member",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FamilyInput" },
              example: {
                name: "Sara Khan",
                relation: "Daughter",
                email: "sara.khan@example.com",
                phone: "+92 301 1112233",
                can_view_adherence: true,
              },
            },
          },
        },
        responses: {
          201: {
            description: "Family member",
            content: { "application/json": { schema: { $ref: "#/components/schemas/FamilyResponse" } } },
          },
        },
      },
    },
    "/api/family-members/{id}": {
      parameters: [{ $ref: "#/components/parameters/id" }],
      put: {
        security: [{ bearerAuth: [] }],
        summary: "Update family member",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/FamilyInput" },
              example: {
                name: "Sara Khan",
                relation: "Daughter",
                email: "sara.khan@example.com",
                phone: "+92 301 1112233",
                can_view_adherence: true,
              },
            },
          },
        },
        responses: {
          200: {
            description: "Family member",
            content: { "application/json": { schema: { $ref: "#/components/schemas/FamilyResponse" } } },
          },
        },
      },
      delete: {
        security: [{ bearerAuth: [] }],
        summary: "Delete family member",
        responses: { 200: { description: "Deleted" } },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    parameters: {
      id: {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
        example: "550e8400-e29b-41d4-a716-446655440000",
      },
      reminderId: {
        name: "reminder_id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
        example: "550e8400-e29b-41d4-a716-446655440000",
      },
    },
    schemas: {
      Register: {
        type: "object",
        required: ["full_name", "email", "password"],
        properties: {
          full_name: { type: "string", minLength: 1, maxLength: 200, example: "Ayesha Khan" },
          email: { type: "string", format: "email", example: "ayesha.khan@example.com" },
          password: { type: "string", minLength: 8, example: "SafePassword123!" },
        },
        example: {
          full_name: "Ayesha Khan",
          email: "ayesha.khan@example.com",
          password: "SafePassword123!",
        },
      },
      Login: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", example: "ayesha.khan@example.com" },
          password: { type: "string", example: "SafePassword123!" },
        },
        example: { email: "ayesha.khan@example.com", password: "SafePassword123!" },
      },
      User: {
        type: "object",
        required: ["id", "full_name", "email", "phone", "date_of_birth", "profile_picture_url", "created_at"],
        properties: {
          id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
          full_name: { type: "string", example: "Ayesha Khan" },
          email: { type: "string", format: "email", example: "ayesha.khan@example.com" },
          phone: { type: "string", nullable: true, example: "+92 300 1234567" },
          date_of_birth: { type: "string", format: "date", nullable: true, example: "1995-06-15" },
          profile_picture_url: { type: "string", format: "uri", nullable: true, example: null },
          created_at: { type: "string", format: "date-time", example: "2026-09-03T08:00:00.000Z" },
        },
      },
      UserResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/User" } },
      },
      AuthData: {
        type: "object",
        required: ["user", "token"],
        properties: {
          user: { $ref: "#/components/schemas/User" },
          token: { type: "string", example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." },
        },
      },
      AuthResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/AuthData" } },
      },
      ProfileUpdate: {
        type: "object",
        minProperties: 1,
        description: "Send at least one profile field. All fields are optional individually.",
        properties: {
          full_name: { type: "string", minLength: 1, example: "Ayesha Khan" },
          phone: { type: "string", nullable: true, example: "+92 300 1234567" },
          date_of_birth: { type: "string", format: "date", nullable: true, example: "1995-06-15" },
        },
        example: { full_name: "Ayesha Khan", phone: "+92 300 1234567", date_of_birth: "1995-06-15" },
      },
      MedicineInput: {
        type: "object",
        required: ["name", "dosage", "reminder_times", "days_of_week"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200, example: "Amoxicillin" },
          dosage: { type: "string", minLength: 1, maxLength: 100, example: "500 mg" },
          form: {
            type: "string",
            enum: ["tablet", "capsule", "syrup", "injection", "drops", "other"],
            default: "tablet",
            example: "capsule",
          },
          frequency_per_day: { type: "integer", minimum: 1, maximum: 10, example: 3 },
          start_date: { type: "string", format: "date", example: "2026-09-03" },
          end_date: { type: "string", format: "date", nullable: true, example: "2026-09-10" },
          instructions: { type: "string", nullable: true, example: "Take after food" },
          reminder_times: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", example: "08:00" },
            example: ["08:00", "14:00", "20:00"],
          },
          days_of_week: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            uniqueItems: true,
            items: { type: "integer", minimum: 1, maximum: 7, example: 1 },
            example: [1, 2, 3, 4, 5, 6, 7],
          },
        },
        example: {
          name: "Amoxicillin",
          dosage: "500 mg",
          form: "capsule",
          frequency_per_day: 3,
          start_date: "2026-09-03",
          end_date: "2026-09-10",
          instructions: "Take after food",
          reminder_times: ["08:00", "14:00", "20:00"],
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
        },
      },
      Medicine: {
        type: "object",
        required: ["id", "name", "dosage", "form", "frequency_per_day", "start_date", "end_date", "instructions", "is_active", "reminders"],
        properties: {
          id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
          name: { type: "string", example: "Amoxicillin" },
          dosage: { type: "string", example: "500 mg" },
          form: { type: "string", example: "capsule" },
          frequency_per_day: { type: "integer", example: 3 },
          start_date: { type: "string", format: "date", example: "2026-09-03" },
          end_date: { type: "string", format: "date", nullable: true, example: "2026-09-10" },
          instructions: { type: "string", nullable: true, example: "Take after food" },
          is_active: { type: "boolean", example: true },
          reminders: { type: "array", items: { $ref: "#/components/schemas/Reminder" } },
        },
      },
      MedicineResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Medicine" } },
      },
      ReminderInput: {
        type: "object",
        required: ["medicine_id", "time_of_day", "days_of_week"],
        properties: {
          medicine_id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
          time_of_day: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", example: "08:00" },
          days_of_week: {
            type: "array",
            minItems: 1,
            maxItems: 7,
            uniqueItems: true,
            items: { type: "integer", minimum: 1, maximum: 7, example: 1 },
            example: [1, 2, 3, 4, 5, 6, 7],
          },
        },
        example: {
          medicine_id: "550e8400-e29b-41d4-a716-446655440000",
          time_of_day: "08:00",
          days_of_week: [1, 2, 3, 4, 5, 6, 7],
        },
      },
      ReminderUpdate: {
        type: "object",
        minProperties: 1,
        description: "Send time_of_day, is_enabled, or both.",
        properties: {
          time_of_day: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$", example: "09:30" },
          is_enabled: { type: "boolean", example: true },
        },
        example: { time_of_day: "09:30", is_enabled: true },
      },
      Reminder: {
        type: "object",
        required: ["id", "time_of_day", "days_of_week", "is_enabled"],
        properties: {
          id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
          time_of_day: { type: "string", example: "08:00" },
          days_of_week: { type: "array", items: { type: "integer", example: 1 }, example: [1, 2, 3, 4, 5, 6, 7] },
          is_enabled: { type: "boolean", example: true },
        },
      },
      ReminderResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Reminder" } },
      },
      AdherenceMarkInput: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["taken", "skipped"], example: "taken" },
          note: { type: "string", nullable: true, example: "Taken with breakfast" },
        },
        example: { status: "taken", note: "Taken with breakfast" },
      },
      AdherenceMarkData: {
        type: "object",
        required: ["log_id", "status", "taken_at"],
        properties: {
          log_id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
          status: { type: "string", enum: ["taken", "skipped"], example: "taken" },
          taken_at: { type: "string", format: "date-time", nullable: true, example: "2026-09-03T08:02:00.000Z" },
        },
      },
      AdherenceMarkResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/AdherenceMarkData" } },
      },
      ContactInput: {
        type: "object",
        required: ["name", "phone"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200, example: "Imran Khan" },
          phone: { type: "string", minLength: 1, maxLength: 50, example: "+92 300 7654321" },
          relation: { type: "string", nullable: true, example: "Brother" },
          is_primary: { type: "boolean", default: false, example: true },
        },
        example: { name: "Imran Khan", phone: "+92 300 7654321", relation: "Brother", is_primary: true },
      },
      Contact: {
        type: "object",
        required: ["id", "name", "phone", "relation", "is_primary", "created_at"],
        properties: {
          id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
          name: { type: "string", example: "Imran Khan" },
          phone: { type: "string", example: "+92 300 7654321" },
          relation: { type: "string", nullable: true, example: "Brother" },
          is_primary: { type: "boolean", example: true },
          created_at: { type: "string", format: "date-time", example: "2026-09-03T08:00:00.000Z" },
        },
      },
      ContactResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/Contact" } },
      },
      SosInput: {
        type: "object",
        properties: { note: { type: "string", nullable: true, example: "I need urgent assistance" } },
        example: { note: "I need urgent assistance" },
      },
      SosContact: {
        type: "object",
        required: ["name", "phone", "relation"],
        properties: {
          name: { type: "string", example: "Imran Khan" },
          phone: { type: "string", example: "+92 300 7654321" },
          relation: { type: "string", nullable: true, example: "Brother" },
        },
      },
      SosData: {
        type: "object",
        required: ["message", "contacts"],
        properties: {
          message: { type: "string", example: "Emergency contacts ready" },
          contacts: { type: "array", items: { $ref: "#/components/schemas/SosContact" } },
        },
      },
      SosResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/SosData" } },
      },
      FamilyInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200, example: "Sara Khan" },
          relation: { type: "string", nullable: true, example: "Daughter" },
          email: { type: "string", format: "email", nullable: true, example: "sara.khan@example.com" },
          phone: { type: "string", nullable: true, example: "+92 301 1112233" },
          can_view_adherence: { type: "boolean", default: false, example: true },
        },
        example: {
          name: "Sara Khan",
          relation: "Daughter",
          email: "sara.khan@example.com",
          phone: "+92 301 1112233",
          can_view_adherence: true,
        },
      },
      FamilyMember: {
        type: "object",
        required: ["id", "name", "relation", "email", "phone", "can_view_adherence", "created_at"],
        properties: {
          id: { type: "string", format: "uuid", example: "550e8400-e29b-41d4-a716-446655440000" },
          name: { type: "string", example: "Sara Khan" },
          relation: { type: "string", nullable: true, example: "Daughter" },
          email: { type: "string", format: "email", nullable: true, example: "sara.khan@example.com" },
          phone: { type: "string", nullable: true, example: "+92 301 1112233" },
          can_view_adherence: { type: "boolean", example: true },
          created_at: { type: "string", format: "date-time", example: "2026-09-03T08:00:00.000Z" },
        },
      },
      FamilyResponse: {
        type: "object",
        required: ["data"],
        properties: { data: { $ref: "#/components/schemas/FamilyMember" } },
      },
    },
  },
};

app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

app.use((_req, res) => sendError(res, 404, "not_found", "Route not found"));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof SyntaxError && error.status === 400 && error.type === "entity.parse.failed") {
    return sendError(res, 400, "validation_error", "Request body must be valid JSON");
  }
  if (error instanceof ApiError) return sendError(res, error.status, error.code, error.message);
  if (error.code === "23514" || error.code === "22P02") {
    return sendError(res, 400, "validation_error", "Input failed validation");
  }
  return sendError(res, 500, "internal", "An unexpected error occurred");
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`MediMind API listening on port ${PORT}`);
});

process.on("SIGTERM", () => server.close(() => pool.end()));
process.on("SIGINT", () => server.close(() => pool.end()));