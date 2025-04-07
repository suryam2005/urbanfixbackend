const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET; // Ensure it's correctly loaded

const isAdmin = (req, res, next) => {
  const tokenHeader = req.headers["authorization"];
  if (!tokenHeader) return res.status(401).json({ message: "Access denied. No token provided." });

  const token = tokenHeader.startsWith("Bearer ") ? tokenHeader.split(" ")[1] : tokenHeader;

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error("JWT Verification Error:", err);
      return res.status(403).json({ message: "Invalid token." });
    }

    console.log("Decoded Admin Token:", user); // ✅ Debugging line

    if (!user.isAdmin) { // ⚠️ Ensure `isAdmin` exists in JWT payload
      return res.status(403).json({ message: "Access denied. Admins only." });
    }

    req.user = user;
    next();
  });
};



// ✅ Correct Export
module.exports = { isAdmin };