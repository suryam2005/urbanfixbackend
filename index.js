// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// Constants
const VALID_TAGS = ['electricity', 'canteen', 'furniture', 'campus'];

app.use(cors()); // This will allow all domains
app.use(express.json());

// Supabase setup using environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Secret key for JWT from environment variables
const JWT_SECRET = process.env.JWT_SECRET;

// Function to generate JWT token
const generateToken = (user) => {
  return jwt.sign({ email: user.email, id: user.id }, JWT_SECRET, { expiresIn: '1h' });
};

// Middleware to authenticate JWT token
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token.' });

    req.user = user;
    next();
  });
};

// Middleware to authenticate admin
const authenticateAdmin = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token.' });

    if (!user.isAdmin) return res.status(403).json({ message: 'Access denied. Admins only.' });

    req.user = user;
    next();
  });
};

// Get complaints with optional tag filter
app.get('/complaints', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { tag } = req.query; // Optional tag filter

    let query = supabase
      .from('complaints')
      .select('*')
      .eq('user_id', userId);

    // Add tag filter if provided
    if (tag && VALID_TAGS.includes(tag)) {
      query = query.contains('tags', [tag]);
    }

    // Order by creation date, newest first
    query = query.order('created_at', { ascending: false });

    const { data: complaints, error } = await query;

    if (error) {
      console.error('Supabase Fetch Error:', error);
      return res.status(500).json({ message: 'Error fetching complaints', error: error.message });
    }

    res.json({ complaints });
  } catch (error) {
    console.error('Unexpected Error:', error.message);
    res.status(500).json({ message: 'Unexpected error occurred', error: error.message });
  }
});

// Submit new complaint
app.post('/submit', authenticateToken, async (req, res) => {
  const { title, description, tags } = req.body;
  const userId = req.user.id;

  if (!title || !description) {
    return res.status(400).json({ message: 'Title and description are required' });
  }

  // Validate tags
  if (tags && !tags.every(tag => VALID_TAGS.includes(tag))) {
    return res.status(400).json({ message: 'Invalid tags provided' });
  }

  try {
    const { data: complaint, error } = await supabase
      .from('complaints')
      .insert([{ 
        user_id: userId, 
        title, 
        description, 
        status: 'pending',
        tags: tags || [] 
      }])
      .select('*');

    if (error) {
      console.error('Supabase Insert Error:', error);
      return res.status(500).json({ message: 'Error inserting complaint', error: error.message });
    }

    console.log('Complaint inserted:', complaint);
    res.status(201).json({ 
      message: 'Complaint submitted successfully', 
      complaint: complaint[0]
    });
  } catch (error) {
    console.error('Unexpected Error:', error.message);
    res.status(500).json({ message: 'Unexpected error occurred', error: error.message });
  }
});

// Add this to your backend code

// Simplified upvote endpoint
app.post('/complaints/:id/upvote', authenticateToken, async (req, res) => {
  const complaintId = req.params.id;
  
  try {
    // Get current complaint
    const { data: complaint, error: fetchError } = await supabase
      .from('complaints')
      .select('upvotes')
      .eq('id', complaintId)
      .single();

    if (fetchError) {
      console.error('Fetch Error:', fetchError);
      return res.status(404).json({ message: 'Complaint not found' });
    }

    // Increment upvotes
    const newUpvotes = (complaint.upvotes || 0) + 1;
    
    const { data: updatedComplaint, error: updateError } = await supabase
      .from('complaints')
      .update({ upvotes: newUpvotes })
      .eq('id', complaintId)
      .select()
      .single();

    if (updateError) {
      console.error('Update Error:', updateError);
      throw updateError;
    }

    res.json(updatedComplaint);
  } catch (error) {
    console.error('Upvote Error:', error);
    res.status(500).json({ message: 'Error processing upvote' });
  }
});

// Get available tags
app.get('/tags', authenticateToken, (req, res) => {
  res.json({ tags: VALID_TAGS });
});

// Admin: Fetch all complaints with filters
app.get('/admin/complaints', authenticateAdmin, async (req, res) => {
  const { status, date, user_id, tag } = req.query;

  let query = supabase.from('complaints').select('*');

  if (status) query = query.eq('status', status);
  if (date) query = query.eq('created_at', date);
  if (user_id) query = query.eq('user_id', user_id);
  if (tag && VALID_TAGS.includes(tag)) {
    query = query.contains('tags', [tag]);
  }

  const { data, error } = await query;

  if (error) return res.status(500).json({ message: 'Error fetching complaints', error });

  res.json({ complaints: data });
});

// Admin: Update complaint status
app.put('/admin/complaints/:id/status', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const { error } = await supabase
    .from('complaints')
    .update({ status })
    .eq('id', id);

  if (error) return res.status(500).json({ message: 'Error updating status', error });

  res.json({ message: 'Complaint status updated' });
});

// Admin: Fetch all users
app.get('/admin/users', authenticateAdmin, async (req, res) => {
  const { data, error } = await supabase.from('users').select('*');

  if (error) return res.status(500).json({ message: 'Error fetching users', error });

  res.json({ users: data });
});

// Admin: Assign complaint to a team member
app.put('/admin/complaints/:id/assign', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { assigned_to } = req.body;

  const { error } = await supabase
    .from('complaints')
    .update({ assigned_to })
    .eq('id', id);

  if (error) return res.status(500).json({ message: 'Error assigning complaint', error });

  res.json({ message: 'Complaint assigned successfully' });
});

// User Signup Endpoint
app.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const { data: user, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } }
    });

    if (error) return res.status(400).json({ message: error.message });

    const token = generateToken(user.user);
    res.status(201).json({ message: 'Signup successful', token, user: user.user });
  } catch (err) {
    res.status(500).json({ message: 'An error occurred during signup.' });
  }
});

// User Login Endpoint
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ message: 'Invalid email or password.' });

    const token = generateToken(data.user);
    res.json({ message: 'Login successful', token });
  } catch (err) {
    res.status(500).json({ message: 'An error occurred during login.' });
  }
});

// Profile endpoint
app.get('/profile', authenticateToken, (req, res) => {
  res.json({ message: 'User profile loaded', email: req.user.email });
});

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'vercel') {
  app.listen(PORT, () => {
    console.log('Server is running on port ' + PORT);
  });
}

// Add this test endpoint to your backend
app.get('/test-db', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('complaints')
      .select('*')
      .limit(1);
    
    if (error) throw error;
    
    res.json({ message: 'Database connection successful', data });
  } catch (error) {
    res.status(500).json({ message: 'Database connection failed', error: error.message });
  }
});

module.exports = app;