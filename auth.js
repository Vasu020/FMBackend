import jwt from "jsonwebtoken";

// Create a signed JWT for a logged-in school/user.
// Always encode school_id + role in the token — never trust these from req.body/query again.
export function generateToken(payload) {
  return jwt.sign(
    {
      id: payload.id,
      school_id: payload.school_id,
      role: payload.role,
      email: payload.email,
    },
    process.env.JWT_SECRET,
    { expiresIn: "8h" },
  );
}

// Verifies "Authorization: Bearer <token>" and attaches the decoded payload to req.user
export function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ message: "Access token required." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ message: "Invalid or expired token." });
    }
    req.user = decoded; // { id, school_id, role, email }
    next();
  });
}

// Use after authenticateToken to restrict a route to admins only
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admin access required." });
  }
  next();
}