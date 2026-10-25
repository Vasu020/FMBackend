import "dotenv/config";
import express from "express";
import pkg from "pg";
import cors from "cors";
import bcrypt from "bcrypt";
import notifyRoutes from "./emailNotify/notifyRoutes.js";
import feeRulesRoutes from "./feeRules/feeRules.js";
import "./emailNotify/dueDateCron.js";
import { generateToken, authenticateToken, requireAdmin } from "./auth.js";

const { Pool } = pkg;
const app = express();
const port = process.env.PORT || 5000 || 5173;

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

function calculateAccruedLateFees(dueDate, feeRule, now = new Date()) {
  if (!feeRule || !feeRule.is_active) return 0;

  const monthlyAmount = Number(feeRule.late_fee_amount) || 0;
  const dueDay = Math.max(1, Number(feeRule.due_day_of_month) || 1);
  const graceDays = Math.max(0, Number(feeRule.grace_days) || 0);
  if (monthlyAmount <= 0) return 0;

  let due;
  if (dueDate) {
    const datePart = String(dueDate).slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
    if (!match) return 0;
    due = new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    );
  } else {
    const lastDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
    ).getUTCDate();
    due = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        Math.min(dueDay, lastDay),
      ),
    );
  }

  const graceDeadline = new Date(due);
  graceDeadline.setUTCDate(graceDeadline.getUTCDate() + graceDays);
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (today <= graceDeadline) return 0;

  let periods = 1;
  for (let offset = 1; offset <= 1200; offset += 1) {
    const month = graceDeadline.getUTCMonth() + offset;
    const year =
      graceDeadline.getUTCFullYear() + Math.floor(month / 12);
    const monthIndex = month % 12;
    const anchorDay = graceDeadline.getUTCDate();
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const anniversary = new Date(
      Date.UTC(year, monthIndex, Math.min(anchorDay, lastDay)),
    );
    if (anniversary > today) break;
    periods += 1;
  }

  return Math.round(periods * monthlyAmount * 100) / 100;
}

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:5000",
    ],
    credentials: true,
  })
);

app.use(express.json());

// Test database connection
try {
  const client = await pool.connect();
  console.log("✅ Database connection established successfully");
  client.release();
  await pool.query(`
    ALTER TABLE students
      ADD COLUMN IF NOT EXISTS late_fees_paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_late_fee_payment_date DATE
  `);
} catch (err) {
  console.error("❌ Database connection error:", err.message);
  process.exit(1);
}

// ─────────────────────────────────────────
// GET /api/schools/:id — Get school by ID (auth required, must be your own school)
// ─────────────────────────────────────────
app.get("/api/schools/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  if (Number(id) !== req.user.school_id) {
    return res.status(403).json({ message: "Forbidden." });
  }

  try {
    const result = await pool.query(
      "SELECT id, school_name, short_name, email, created_at, updated_at FROM schools WHERE id = $1",
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "School not found" });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ─────────────────────────────────────────
// POST /api/schools/ — Register a new school (public — no token yet)
// ─────────────────────────────────────────
app.post("/api/schools", async (req, res) => {
  const { school_name, short_name, email, password } = req.body;

  if (!school_name || !email || !password) {
    return res
      .status(400)
      .json({ message: "school_name, email, and password are required." });
  }
  if (password.length < 8) {
    return res
      .status(400)
      .json({ message: "Password must be at least 8 characters." });
  }

  const client = await pool.connect();
  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    await client.query("BEGIN");

    const schoolResult = await client.query(
      `INSERT INTO schools (school_name, short_name, email)
       VALUES ($1, $2, $3)
       RETURNING id, school_name, short_name, email, created_at`,
      [school_name, short_name, email],
    );
    const school = schoolResult.rows[0];

    await client.query(
      `INSERT INTO users (school_id, name, email, password, role)
       VALUES ($1, $2, $3, $4, 'admin')`,
      [school.id, school_name, email, hashedPassword],
    );

    await client.query("COMMIT");

    res.status(201).json({
      message: "School registered successfully. You can now log in.",
      school,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ message: "This email is already registered." });
    }
    res.status(500).json({ message: "Internal server error." });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────
// POST /api/schools/login — issues a JWT
// ─────────────────────────────────────────
app.post("/api/schools/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ message: "Email and password are required." });
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();

    const result = await pool.query(
      "SELECT id, school_name, short_name, email, password FROM schools WHERE LOWER(email) = $1",
      [normalizedEmail],
    );

    if (result.rows.length === 0) {
      return res
        .status(401)
        .json({ message: "Invalid credentials. Please try again." });
    }

    const school = result.rows[0];
    const isMatch = await bcrypt.compare(password, school.password);

    if (!isMatch) {
      return res
        .status(401)
        .json({ message: "Invalid credentials. Please try again." });
    }

    const token = generateToken({
      id: school.id,
      school_id: school.id,
      role: "admin",
      email: school.email,
    });

    res.status(200).json({
      message: "Login successful.",
      token,
      school: {
        id: school.id,
        school_name: school.school_name,
        short_name: school.short_name,
        email: school.email,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// POST /api/users/reset-password
// ─────────────────────────────────────────
app.post("/api/users/reset-password", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res
      .status(400)
      .json({ message: "Email and new password are required." });
  if (password.length < 8)
    return res
      .status(400)
      .json({ message: "Password must be at least 8 characters." });

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const check = await pool.query(
      "SELECT id FROM users WHERE LOWER(email) = $1",
      [normalizedEmail],
    );

    if (check.rows.length === 0) {
      return res.status(200).json({
        message: "If this email is registered, the password has been updated.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await pool.query("UPDATE users SET password = $1 WHERE LOWER(email) = $2", [
      hashedPassword,
      normalizedEmail,
    ]);

    res.status(200).json({ message: "Password updated successfully." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// POST /api/users/login — issues a JWT
// ─────────────────────────────────────────
app.post("/api/users/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ message: "Email and password are required." });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.password, u.role, u.school_id,
              s.school_name, s.short_name
       FROM users u
       JOIN schools s ON s.id = u.school_id
       WHERE u.email = $1`,
      [email],
    );

    if (result.rows.length === 0) {
      return res
        .status(401)
        .json({ message: "Invalid credentials. Please try again." });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res
        .status(401)
        .json({ message: "Invalid credentials. Please try again." });
    }

    const token = generateToken({
      id: user.id,
      school_id: user.school_id,
      role: user.role,
      email: user.email,
    });

    res.status(200).json({
      message: "Login successful.",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        school_id: user.school_id,
        school_name: user.school_name,
        short_name: user.short_name,
      },
    });
  } catch (err) {
    console.error(err);
   res.status(500).json({ message: "Internal server error.", detail: err.message, code: err.code });
  }
});

// ─────────────────────────────────────────
// POST /api/users — Admin creates a new non-admin user under THEIR OWN school
// ─────────────────────────────────────────
app.post("/api/users", authenticateToken, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  const school_id = req.user.school_id; // never trust client-supplied school_id here

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ message: "name, email, and password are required." });
  }

  const assignedRole = role === "admin" ? "admin" : "user";

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ message: "Invalid email format." });
  }

  if (password.length < 8) {
    return res
      .status(400)
      .json({ message: "Password must be at least 8 characters." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (school_id, name, email, password, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, school_id, created_at`,
      [school_id, name, email, hashedPassword, assignedRole],
    );

    res.status(201).json({
      message: "User created successfully.",
      user: result.rows[0],
    });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ message: "A user with this email already exists." });
    }
    res.status(500).json({ message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// GET /api/users — Get all users under YOUR school (admin only)
// ─────────────────────────────────────────
app.get("/api/users", authenticateToken, requireAdmin, async (req, res) => {
  const school_id = req.user.school_id;

  try {
    const result = await pool.query(
      `SELECT id, name, email, role, created_at FROM users
       WHERE school_id = $1 ORDER BY created_at DESC`,
      [school_id],
    );

    res.status(200).json({
      message: "Users fetched successfully.",
      data: result.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// DELETE /api/users/:id — Admin deletes a user (must belong to the same school)
// ─────────────────────────────────────────
app.delete("/api/users/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM users WHERE id = $1 AND school_id = $2 RETURNING id",
      [id, req.user.school_id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found." });
    }

    res.status(200).json({ message: "User deleted successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// GET /api/students — always scoped to the caller's school
// ─────────────────────────────────────────
app.get("/api/students", authenticateToken, async (req, res) => {
  const school_id = req.user.school_id;

  try {
    const [studentsResult, ruleResult] = await Promise.all([
      pool.query(
        "SELECT * FROM students WHERE school_id = $1 ORDER BY student_id ASC",
        [school_id],
      ),
      pool.query(
        `SELECT due_day_of_month, grace_days, late_fee_amount, is_active
         FROM fee_rules
         WHERE rule_type = 'late_fee' AND is_active = true
         ORDER BY created_at DESC
         LIMIT 1`,
      ),
    ]);

    const feeRule = ruleResult.rows[0] ?? null;
    const students = studentsResult.rows.map((student) => {
      const accruedFees = Math.max(
        Number(student.late_fees_charges) || 0,
        calculateAccruedLateFees(student.due_date, feeRule),
      );
      const paidFees = Math.max(Number(student.late_fees_paid) || 0, 0);
      return {
        ...student,
        late_fees_charges: accruedFees,
        late_fees_paid: paidFees,
        late_fees_balance: Math.max(accruedFees - paidFees, 0),
      };
    });

    res.status(200).json({
      status: "success",
      data: students,
      message: "Students fetched successfully",
    });
  } catch (err) {
    console.error("GET /api/students error:", err.stack);
    res.status(500).json({
      status: "error",
      data: null,
      message: "Failed to fetch students: " + err.message,
    });
  }
});

// ─────────────────────────────────────────
// POST /api/students/:id/late-fee-payments — update the student's late-fee total
// ─────────────────────────────────────────
app.post(
  "/api/students/:id/late-fee-payments",
  authenticateToken,
  async (req, res) => {
    const { id } = req.params;
    const school_id = req.user.school_id;
    const amount = Number(req.body.amount);
    const paymentDate = req.body.payment_date;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        status: "error",
        message: "Payment amount must be greater than zero.",
      });
    }
    if (
      typeof paymentDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate) ||
      Number.isNaN(Date.parse(`${paymentDate}T00:00:00Z`))
    ) {
      return res.status(400).json({
        status: "error",
        message: "A valid payment date is required.",
      });
    }
    if (paymentDate > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({
        status: "error",
        message: "Payment date cannot be in the future.",
      });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const studentResult = await client.query(
        `SELECT * FROM students
         WHERE student_id = $1 AND school_id = $2
         FOR UPDATE`,
        [id, school_id],
      );
      if (studentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          status: "error",
          message: "Student not found.",
        });
      }

      const student = studentResult.rows[0];
      const ruleResult = await client.query(
        `SELECT due_day_of_month, grace_days, late_fee_amount, is_active
         FROM fee_rules
         WHERE rule_type = 'late_fee' AND is_active = true
         ORDER BY created_at DESC
         LIMIT 1`,
      );
      const accruedFees = Math.max(
        Number(student.late_fees_charges) || 0,
        calculateAccruedLateFees(student.due_date, ruleResult.rows[0] ?? null),
      );
      const paidBefore = Math.max(Number(student.late_fees_paid) || 0, 0);
      const pending = Math.max(accruedFees - paidBefore, 0);

      if (amount > pending) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          status: "error",
          message: `Payment exceeds the pending late fee of ${pending.toFixed(2)}.`,
        });
      }

      const paidAfter = Math.round((paidBefore + amount) * 100) / 100;
      const updateResult = await client.query(
        `UPDATE students
         SET late_fees_paid = $1, last_late_fee_payment_date = $2
         WHERE student_id = $3 AND school_id = $4
         RETURNING late_fees_paid, last_late_fee_payment_date`,
        [paidAfter, paymentDate, id, school_id],
      );

      await client.query("COMMIT");
      return res.status(201).json({
        status: "success",
        data: {
          student_id: Number(id),
          late_fees_charges: accruedFees,
          late_fees_paid: Number(updateResult.rows[0].late_fees_paid),
          late_fees_balance: Math.max(accruedFees - paidAfter, 0),
          last_late_fee_payment_date:
            updateResult.rows[0].last_late_fee_payment_date,
        },
        message: "Late-fee payment recorded.",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("POST /api/students/:id/late-fee-payments error:", err);
      return res.status(500).json({
        status: "error",
        message: "Failed to record late-fee payment.",
      });
    } finally {
      client.release();
    }
  },
);

// ─────────────────────────────────────────
// POST /api/students — add student; school_id always comes from the token
// ─────────────────────────────────────────
app.post("/api/students", authenticateToken, async (req, res) => {
  const school_id = req.user.school_id;
  const {
    first_name,
    last_name,
    father_name,
    date_of_birth,
    gender,
    contact_phone,
    email,
    total_fees,
    fees_paid,
    balance,
    late_fees_charges,
    late_fees_paid,
    last_late_fee_payment_date,
    concession,
    scholarship,
    last_payment_date,
    due_date,
    enrollment_date,
    status,
    roll_no,
    standard,
  } = req.body;

  if (!first_name || !father_name || !email) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Missing required fields: first_name, father_name, email",
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Invalid email format",
    });
  }

  const numericFields = {
    total_fees,
    fees_paid,
    balance,
    late_fees_charges,
    late_fees_paid,
    concession,
    scholarship,
  };
  for (const [key, value] of Object.entries(numericFields)) {
    if (value !== undefined && isNaN(Number(value))) {
      return res.status(400).json({
        status: "error",
        data: null,
        message: `Invalid numeric value for ${key}`,
      });
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO students (
        school_id,
        first_name, last_name, father_name, date_of_birth, gender, contact_phone, email,
        total_fees, fees_paid, balance, late_fees_charges, late_fees_paid,
        last_late_fee_payment_date, concession, scholarship,
        last_payment_date, due_date, enrollment_date, status, roll_no, standard
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING *`,
      [
        school_id,
        first_name,
        last_name,
        father_name,
        date_of_birth || null,
        gender || null,
        contact_phone || null,
        email,
        Number(total_fees) || 0,
        Number(fees_paid) || 0,
        Number(balance) || 0,
        Number(late_fees_charges) || 0,
        Number(late_fees_paid) || 0,
        last_late_fee_payment_date || null,
        Number(concession) || 0,
        Number(scholarship) || 0,
        last_payment_date || null,
        due_date || null,
        enrollment_date || null,
        status || "active",
        roll_no,
        standard,
      ],
    );

    res.status(201).json({
      status: "success",
      data: result.rows[0],
      message: "Student added successfully",
    });
  } catch (err) {
    console.error("POST /api/students error:", err.stack);
    const isDuplicate = err.code === "23505";
    res.status(isDuplicate ? 409 : 500).json({
      status: "error",
      data: null,
      message: isDuplicate
        ? "Email already exists"
        : "Failed to add student: " + err.message,
    });
  }
});

// ─────────────────────────────────────────
// PUT /api/students/:id — update, scoped to the caller's school
// ─────────────────────────────────────────
app.put("/api/students/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const school_id = req.user.school_id;

  let existing;
  try {
    const existing_result = await pool.query(
      "SELECT * FROM students WHERE student_id = $1 AND school_id = $2",
      [id, school_id],
    );
    if (existing_result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        data: null,
        message: `Student with ID ${id} not found`,
      });
    }
    existing = existing_result.rows[0];
  } catch (err) {
    return res.status(500).json({
      status: "error",
      data: null,
      message: "Failed to fetch student: " + err.message,
    });
  }

  const body = req.body;

  const first_name = body.first_name ?? existing.first_name;
  const last_name = body.last_name ?? existing.last_name;
  const father_name = body.father_name ?? existing.father_name;
  const date_of_birth = body.date_of_birth ?? existing.date_of_birth;
  const gender = body.gender ?? existing.gender;
  const contact_phone = body.contact_phone ?? existing.contact_phone;
  const email = body.email ?? existing.email;
  const total_fees = body.total_fees ?? existing.total_fees;
  const fees_paid = body.fees_paid ?? existing.fees_paid;
  const balance = body.balance ?? existing.balance;
  const late_fees_charges =
    body.late_fees_charges ?? existing.late_fees_charges;
  const late_fees_paid = existing.late_fees_paid ?? 0;
  const last_late_fee_payment_date =
    existing.last_late_fee_payment_date ?? null;
  const concession = body.concession ?? existing.concession;
  const scholarship = body.scholarship ?? existing.scholarship;
  const last_payment_date =
    body.last_payment_date ?? existing.last_payment_date;
  const due_date = body.due_date ?? existing.due_date;
  const enrollment_date = body.enrollment_date ?? existing.enrollment_date;
  const status = body.status ?? existing.status;
  const roll_no = body.roll_no ?? existing.roll_no;
  const standard = body.standard ?? existing.standard;

  if (!first_name || !father_name || !email) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Missing required fields: first_name, father_name, email",
    });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Invalid email format",
    });
  }

  const numericFields = {
    total_fees,
    fees_paid,
    balance,
    late_fees_charges,
    late_fees_paid,
    concession,
    scholarship,
    roll_no,
  };
  for (const [key, value] of Object.entries(numericFields)) {
    if (value !== undefined && value !== null && isNaN(Number(value))) {
      return res.status(400).json({
        status: "error",
        data: null,
        message: `Invalid numeric value for ${key}`,
      });
    }
  }

  try {
    const result = await pool.query(
      `UPDATE students SET
        first_name = $1, last_name = $2, father_name = $3, date_of_birth = $4, gender = $5,
        contact_phone = $6, email = $7, total_fees = $8, fees_paid = $9, balance = $10,
        late_fees_charges = $11, late_fees_paid = $12,
        last_late_fee_payment_date = $13, concession = $14, scholarship = $15,
        last_payment_date = $16, due_date = $17, enrollment_date = $18,
        status = $19, roll_no = $20, standard = $21
      WHERE student_id = $22 AND school_id = $23 RETURNING *`,
      [
        first_name,
        last_name || null,
        father_name,
        date_of_birth || null,
        gender || null,
        contact_phone || null,
        email,
        Number(total_fees) || 0,
        Number(fees_paid) || 0,
        Number(balance) || 0,
        Number(late_fees_charges) || 0,
        Number(late_fees_paid) || 0,
        last_late_fee_payment_date,
        Number(concession) || 0,
        Number(scholarship) || 0,
        last_payment_date || null,
        due_date || null,
        enrollment_date || null,
        status || "active",
        roll_no || null,
        standard || null,
        id,
        school_id,
      ],
    );

    res.status(200).json({
      status: "success",
      data: result.rows[0],
      message: "Student updated successfully",
    });
  } catch (err) {
    console.error("PUT /api/students/:id error:", err.stack);
    res.status(err.code === "23505" ? 409 : 500).json({
      status: "error",
      data: null,
      message:
        err.code === "23505"
          ? "Email already exists"
          : "Failed to update student: " + err.message,
    });
  }
});

// ─────────────────────────────────────────
// DELETE /api/students/:id — scoped to the caller's school
// ─────────────────────────────────────────
app.delete("/api/students/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM students WHERE student_id = $1 AND school_id = $2 RETURNING *",
      [id, req.user.school_id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        status: "error",
        data: null,
        message: `Student with ID ${id} not found`,
      });
    }
    res.status(200).json({
      status: "success",
      data: null,
      message: "Student deleted successfully",
    });
  } catch (err) {
    console.error("DELETE /api/students/:id error:", err.stack);
    res.status(500).json({
      status: "error",
      data: null,
      message: "Failed to delete student: " + err.message,
    });
  }
});

// --- Class Table APIs ---

// ─────────────────────────────────────────
// GET /api/classes — scoped to the caller's school
// ─────────────────────────────────────────
app.get("/api/classes", authenticateToken, async (req, res) => {
  const school_id = req.user.school_id;

  try {
    const result = await pool.query(
      "SELECT * FROM classes WHERE school_id = $1 ORDER BY classname ASC",
      [school_id],
    );

    res.status(200).json({
      status: "success",
      data: result.rows,
      message: "Classes fetched successfully",
    });
  } catch (err) {
    console.error("GET /api/classes error:", err.stack);
    res.status(500).json({
      status: "error",
      data: null,
      message: "Failed to fetch classes: " + err.message,
    });
  }
});

// ─────────────────────────────────────────
// POST /api/classes — create class linked to the caller's school
// ─────────────────────────────────────────
app.post("/api/classes", authenticateToken, async (req, res) => {
  const school_id = req.user.school_id;
  let {
    classname,
    students,
    sections,
    tutions,
    admission,
    annual,
    others,
    otherCategories = [],
  } = req.body;

  if (!classname || students === undefined || sections === undefined) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "classname, students, and sections are required.",
    });
  }

  tutions = tutions ?? 0;
  admission = admission ?? 0;
  annual = annual ?? 0;
  others = others ?? 0;

  if (!Array.isArray(otherCategories)) otherCategories = [];

  try {
    const result = await pool.query(
      `INSERT INTO classes 
        (school_id, classname, students, sections, tutions, admission, annual, others, "otherCategories") 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING *`,
      [
        school_id,
        classname,
        students,
        sections,
        tutions,
        admission,
        annual,
        others,
        JSON.stringify(otherCategories),
      ],
    );

    res.status(201).json({
      status: "success",
      data: result.rows[0],
      message: "Class created successfully",
    });
  } catch (err) {
    console.error("POST /api/classes error:", err.stack);
    res.status(500).json({
      status: "error",
      data: null,
      message: "Failed to create class: " + err.message,
    });
  }
});

// ─────────────────────────────────────────
// PUT /api/classes/:id — update, scoped to the caller's school
// ─────────────────────────────────────────
app.put("/api/classes/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const school_id = req.user.school_id;
  const updates = req.body;

  const allowedFields = [
    "classname",
    "students",
    "sections",
    "tutions",
    "admission",
    "annual",
    "others",
    "otherCategories",
  ];

  const fieldsToUpdate = Object.keys(updates).filter(
    (key) => allowedFields.includes(key) && updates[key] !== undefined,
  );

  if (fieldsToUpdate.length === 0) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "No valid fields provided for update.",
    });
  }

  try {
    const setClauses = [];
    const values = [];
    let paramIndex = 1;

    for (const field of fieldsToUpdate) {
      let value = updates[field];

      if (field === "otherCategories") {
        if (!Array.isArray(value)) value = [];
        value = JSON.stringify(value);
        setClauses.push(`"otherCategories" = $${paramIndex++}`);
      } else {
        setClauses.push(`"${field}" = $${paramIndex++}`);
      }

      values.push(value);
    }

    values.push(id, school_id);

    const queryText = `
      UPDATE classes 
      SET ${setClauses.join(", ")}
      WHERE id = $${values.length - 1} AND school_id = $${values.length}
      RETURNING *
    `;

    const result = await pool.query(queryText, values);

    if (result.rowCount === 0) {
      return res.status(404).json({
        status: "error",
        data: null,
        message: "Class not found",
      });
    }

    res.status(200).json({
      status: "success",
      data: result.rows[0],
      message: "Class updated successfully",
    });
  } catch (err) {
    console.error("PUT /api/classes/:id error:", err.stack);
    res.status(500).json({
      status: "error",
      data: null,
      message: "Failed to update class: " + err.message,
    });
  }
});

// ─────────────────────────────────────────
// GET /api/settings — admin only
// ─────────────────────────────────────────
app.get("/api/settings", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT key, value FROM app_settings ORDER BY id ASC"
    );

    const settings = result.rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {});

    res.status(200).json({ success: true, data: settings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// PUT /api/settings — admin only
// ─────────────────────────────────────────
app.put("/api/settings", authenticateToken, requireAdmin, async (req, res) => {
  const settings = req.body;

  if (!settings || Object.keys(settings).length === 0) {
    return res.status(400).json({ success: false, message: "No settings provided." });
  }

  try {
    await pool.query("BEGIN");

    for (const [key, value] of Object.entries(settings)) {
      await pool.query(
        `UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = $2`,
        [value, key]
      );
    }

    await pool.query("COMMIT");
    res.status(200).json({ success: true, message: "Settings saved successfully." });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
});

app.use("/api/notify", authenticateToken, notifyRoutes);

app.use("/api/fee-rules", authenticateToken, feeRulesRoutes);

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});