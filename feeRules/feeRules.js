// routes/feeRules.js
import express from 'express';
const router = express.Router();
import { Pool } from "pg";

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});


/**
 * POST /api/fee-rules
 * Body examples:
 *
 * Late Fee:
 * { "rule_type": "late_fee", "due_day_of_month": 10, "grace_days": 5, "late_fee_amount": 200 }
 *
 * Concession:
 * { "rule_type": "concession", "preset_name": "Sibling Discount", "value_type": "flat", "value": 500, "applicable_classes": ["Class 1", "Class 2"] }
 *
 * Scholarship:
 * { "rule_type": "scholarship", "preset_name": "Merit Scholarship", "value_type": "percentage", "value": 10, "applicable_classes": null }
 */
router.post('/', async (req, res) => {
  const {
    rule_type,
    // late_fee fields
    due_day_of_month,
    grace_days,
    late_fee_amount,
    // concession / scholarship fields
    preset_name,
    value_type,
    value,
    applicable_classes,
  } = req.body;

  // ── Validation ────────────────────────────────────────────
  const validTypes = ['late_fee', 'concession', 'scholarship'];
  if (!rule_type || !validTypes.includes(rule_type)) {
    return res.status(400).json({
      success: false,
      message: `rule_type is required and must be one of: ${validTypes.join(', ')}`,
    });
  }

  if (rule_type === 'late_fee') {
    if (!due_day_of_month || !late_fee_amount) {
      return res.status(400).json({
        success: false,
        message: 'due_day_of_month and late_fee_amount are required for late_fee',
      });
    }
  } else {
    if (!preset_name || !value_type || value === undefined) {
      return res.status(400).json({
        success: false,
        message: 'preset_name, value_type, and value are required for concession/scholarship',
      });
    }
    if (!['flat', 'percentage'].includes(value_type)) {
      return res.status(400).json({
        success: false,
        message: 'value_type must be "flat" or "percentage"',
      });
    }
  }

  // ── Insert ────────────────────────────────────────────────
  try {
    const result = await pool.query(
      `INSERT INTO fee_rules
        (rule_type, due_day_of_month, grace_days, late_fee_amount,
         preset_name, value_type, value, applicable_classes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        rule_type,
        due_day_of_month ?? null,
        grace_days ?? 0,
        late_fee_amount ?? null,
        preset_name ?? null,
        value_type ?? null,
        value ?? null,
        applicable_classes ?? null,
      ]
    );

    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to create fee rule' });
  }
});

/**
 * GET /api/fee-rules?type=late_fee|concession|scholarship
 * Fetch all active rules, optionally filtered by rule_type
 */
router.get('/', async (req, res) => {
  const { type } = req.query;

  const validTypes = ['late_fee', 'concession', 'scholarship'];
  if (type && !validTypes.includes(type)) {
    return res.status(400).json({
      success: false,
      message: `type must be one of: ${validTypes.join(', ')}`,
    });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM fee_rules
       WHERE is_active = true
       ${type ? 'AND rule_type = $1' : ''}
       ORDER BY created_at DESC`,
      type ? [type] : []
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch fee rules' });
  }
});

/**
 * GET /api/fee-rules/:id
 * Fetch a single fee rule by ID
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'SELECT * FROM fee_rules WHERE id = $1 AND is_active = true',
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Fee rule not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to fetch fee rule' });
  }
});

/**
 * PUT /api/fee-rules/:id
 * Update a fee rule by ID (only pass fields you want to change)
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const {
    due_day_of_month,
    grace_days,
    late_fee_amount,
    preset_name,
    value_type,
    value,
    applicable_classes,
  } = req.body;

  try {
    // Fetch existing row first to know its rule_type
    const existing = await pool.query(
      'SELECT * FROM fee_rules WHERE id = $1 AND is_active = true',
      [id]
    );

    if (existing.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Fee rule not found' });
    }

    const current = existing.rows[0];

    // Merge incoming fields with existing values (only update what's provided)
    const updated = {
      due_day_of_month: due_day_of_month ?? current.due_day_of_month,
      grace_days:       grace_days       ?? current.grace_days,
      late_fee_amount:  late_fee_amount  ?? current.late_fee_amount,
      preset_name:      preset_name      ?? current.preset_name,
      value_type:       value_type       ?? current.value_type,
      value:            value            ?? current.value,
      applicable_classes: applicable_classes !== undefined
                            ? applicable_classes
                            : current.applicable_classes,
    };

    const result = await pool.query(
      `UPDATE fee_rules SET
        due_day_of_month   = $1,
        grace_days         = $2,
        late_fee_amount    = $3,
        preset_name        = $4,
        value_type         = $5,
        value              = $6,
        applicable_classes = $7,
        updated_at         = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        updated.due_day_of_month,
        updated.grace_days,
        updated.late_fee_amount,
        updated.preset_name,
        updated.value_type,
        updated.value,
        updated.applicable_classes,
        id,
      ]
    );

    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to update fee rule' });
  }
});

export default router;