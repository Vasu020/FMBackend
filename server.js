import "dotenv/config";
import express from "express";
import pkg from "pg";
import cors from "cors";
import bcrypt from "bcrypt";
import notifyRoutes from "./emailNotify/notifyRoutes.js";
import feeRulesRoutes from "./feeRules/feeRules.js";
import "./emailNotify/dueDateCron.js";

const { Pool } = pkg;
const app = express();
const port = process.env.PORT || 5000;

Middleware
app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:5000",
    ],
    credentials: true,
  }),
);

// const pool = new Pool({
//   user: process.env.DB_USER,
//   host: process.env.DB_HOST,
//   database: process.env.DB_NAME,
//   password: process.env.DB_PASSWORD,
//   port: process.env.DB_PORT,
// });

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // ✅ Required for Render Postgres
});;

app.use(express.json());

// Test database connection
try {
  const client = await pool.connect();
  console.log("✅ Database connection established successfully");
  client.release();
} catch (err) {
  console.error("❌ Database connection error:", err.message);
  process.exit(1);
}

// GET /api/schools/:id — Get school by ID
app.get("/api/schools/:id", async (req, res) => {
  const { id } = req.params;

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
// POST /api/schools/ — Create a new school
app.post("/api/schools", async (req, res) => {
  const { school_name, short_name, email, password, phone } = req.body;

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

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    // Step 1 — Create the school
    const schoolResult = await pool.query(
      `INSERT INTO schools (school_name, short_name, email)
       VALUES ($1, $2, $3)
       RETURNING id, school_name, short_name, email, created_at`,
      [school_name, short_name, email],
    );

    const school = schoolResult.rows[0];

    // Step 2 — Admin user is the single source of truth for auth
    await pool.query(
      `INSERT INTO users (school_id, name, email, password, role)
       VALUES ($1, $2, $3, $4, 'admin')`,
      [school.id, school_name, email, hashedPassword],
    );

    res.status(201).json({
      message: "School registered successfully. You can now log in.",
      school,
    });
  } catch (err) {
    console.error(err);
    if (err.code === "23505") {
      return res
        .status(409)
        .json({ message: "This email is already registered." });
    }
    res.status(500).json({ message: "Internal server error." });
  }
});

// POST /api/schools/login
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

    // Compare entered password with hashed password in DB
    const isMatch = await bcrypt.compare(password, school.password);

    if (!isMatch) {
      return res
        .status(401)
        .json({ message: "Invalid credentials. Please try again." });
    }

    // Return safe school info (never return password)
    res.status(200).json({
      message: "Login successful.",
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

// POST /api/users/reset-password
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
// POST /api/users/login
// Login for both admin and non-admin users
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

    res.status(200).json({
      message: "Login successful.",
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
    res.status(500).json({ message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// POST /api/users
// Admin creates a new non-admin user under their school
// ─────────────────────────────────────────
app.post("/api/users", async (req, res) => {
  const { school_id, name, email, password, role } = req.body;

  if (!school_id || !name || !email || !password) {
    return res
      .status(400)
      .json({ message: "school_id, name, email, and password are required." });
  }

  // Only allow 'user' role to be created this way (admin is created via school registration)
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
// GET /api/users?school_id=1
// Get all users under a school (admin only)
// ─────────────────────────────────────────
app.get("/api/users", async (req, res) => {
  const { school_id } = req.query;

  if (!school_id) {
    return res.status(400).json({ message: "school_id is required." });
  }

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
// DELETE /api/users/:id
// Admin deletes a user
// ─────────────────────────────────────────
app.delete("/api/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
    res.status(200).json({ message: "User deleted successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Internal server error." });
  }
});

// ─────────────────────────────────────────
// GET /api/students
// ─────────────────────────────────────────
app.get("/api/students", async (req, res) => {
  const { school_id } = req.query; // passed as ?school_id=1

  if (!school_id) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "school_id is required.",
    });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM students WHERE school_id = $1 ORDER BY student_id ASC",
      [school_id],
    );

    res.status(200).json({
      status: "success",
      data: result.rows,
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
// POST /api/students — add student with school_id
// ─────────────────────────────────────────

app.post("/api/students", async (req, res) => {
  const {
    school_id, // ← new
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
    concession,
    scholarship,
    last_payment_date,
    due_date,
    enrollment_date,
    status,
    roll_no,
    standard,
  } = req.body;

  // Validate required fields
  if (!school_id) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "school_id is required.",
    });
  }

  if (!first_name || !father_name || !email) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Missing required fields: first_name, father_name, email",
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Invalid email format",
    });
  }

  // Validate numeric fields
  const numericFields = {
    total_fees,
    fees_paid,
    balance,
    late_fees_charges,
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
        total_fees, fees_paid, balance, late_fees_charges, concession, scholarship,
        last_payment_date, due_date, enrollment_date, status, roll_no, standard
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
      RETURNING *`,
      [
        school_id, // $1 ← new
        first_name, // $2
        last_name, // $3
        father_name, // $4
        date_of_birth || null,
        gender || null,
        contact_phone || null,
        email,
        Number(total_fees) || 0,
        Number(fees_paid) || 0,
        Number(balance) || 0,
        Number(late_fees_charges) || 0,
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

// PUT: Update a student by ID
app.put("/api/students/:id", async (req, res) => {
  const { id } = req.params;

  // ── 1. Fetch existing student ──────────────────────────────────────────────
  let existing;
  try {
    const existing_result = await pool.query(
      "SELECT * FROM students WHERE student_id = $1",
      [id],
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

  // ── 2. Merge incoming fields over existing values ──────────────────────────
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
  const concession = body.concession ?? existing.concession;
  const scholarship = body.scholarship ?? existing.scholarship;
  const last_payment_date =
    body.last_payment_date ?? existing.last_payment_date;
  const due_date = body.due_date ?? existing.due_date;
  const enrollment_date = body.enrollment_date ?? existing.enrollment_date;
  const status = body.status ?? existing.status;
  const roll_no = body.roll_no ?? existing.roll_no;
  const standard = body.standard ?? existing.standard;

  // ── 3. Validate required fields (now always satisfied via merge) ───────────
  if (!first_name || !father_name || !email) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Missing required fields: first_name, father_name, email",
    });
  }

  // ── 4. Validate email format ───────────────────────────────────────────────
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "Invalid email format",
    });
  }

  // ── 5. Validate numeric fields (FIXED: only reject truly non-numeric) ──────
  const numericFields = {
    total_fees,
    fees_paid,
    balance,
    late_fees_charges,
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

  // ── 6. Run the update ──────────────────────────────────────────────────────
  try {
    const result = await pool.query(
      `UPDATE students SET
        first_name = $1, last_name = $2, father_name = $3, date_of_birth = $4, gender = $5,
        contact_phone = $6, email = $7, total_fees = $8, fees_paid = $9, balance = $10,
        late_fees_charges = $11, concession = $12, scholarship = $13,
        last_payment_date = $14, due_date = $15, enrollment_date = $16,
        status = $17, roll_no = $18, standard = $19
      WHERE student_id = $20 RETURNING *`,
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
        Number(concession) || 0,
        Number(scholarship) || 0,
        last_payment_date || null,
        due_date || null,
        enrollment_date || null,
        status || "active",
        roll_no || null,
        standard || null,
        id,
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
// DELETE: Remove a student by ID
app.delete("/api/students/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      "DELETE FROM students WHERE student_id = $1 RETURNING *",
      [id],
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

// GET /api/classes — fetch only classes belonging to the school
app.get("/api/classes", async (req, res) => {
  const { school_id } = req.query; // ?school_id=1

  if (!school_id) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "school_id is required.",
    });
  }

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

// POST /api/classes — create class linked to a school
app.post("/api/classes", async (req, res) => {
  let {
    school_id,
    classname,
    students,
    sections,
    tutions,
    admission,
    annual,
    others,
    otherCategories = [], // ← Keep camelCase
  } = req.body;

  if (!school_id) {
    return res
      .status(400)
      .json({ status: "error", data: null, message: "school_id is required." });
  }

  if (!classname || students === undefined || sections === undefined) {
    return res.status(400).json({
      status: "error",
      data: null,
      message: "classname, students, and sections are required.",
    });
  }

  // Default values
  tutions = tutions ?? 0;
  admission = admission ?? 0;
  annual = annual ?? 0;
  others = others ?? 0;

  // Ensure otherCategories is array
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
        JSON.stringify(otherCategories), // ← Important: Stringify
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

// PUT: Update an existing class by id
app.put("/api/classes/:id", async (req, res) => {
  const { id } = req.params;
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
        value = JSON.stringify(value); // Convert array to JSON string
        setClauses.push(`"otherCategories" = $${paramIndex++}`);
      } else {
        setClauses.push(`"${field}" = $${paramIndex++}`);
      }

      values.push(value);
    }

    values.push(id);

    const queryText = `
      UPDATE classes 
      SET ${setClauses.join(", ")}
      WHERE id = $${values.length}
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

// GET /api/settings — fetch all settings
app.get("/api/settings", async (req, res) => {
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

// PUT /api/settings — bulk update all settings at once
app.put("/api/settings", async (req, res) => {
  const settings = req.body;
  // e.g. { date_format: "DD/MM/YYYY", theme: "Light", session_start_month: "4" }

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

app.use("/api/notify", notifyRoutes);

app.use("/api/fee-rules", feeRulesRoutes);

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
