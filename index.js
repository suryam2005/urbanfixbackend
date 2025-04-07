// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
const punycode = require("punycode/");
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { isAdmin } = require("./authMiddleware");



// Constants
const VALID_TAGS = ['electricity', 'canteen', 'furniture', 'campus'];

const allowedOrigins = ['https://urbanfix.madrasco.space', 'http://127.0.0.1:5500'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Supabase setup using environment variables
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Secret key for JWT from environment variables
const JWT_SECRET = process.env.JWT_SECRET;

// Function to generate JWT token
const generateToken = (user) => {
  return jwt.sign(
    { email: user.email, id: user.id, isAdmin: user.user_metadata?.admin || false },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
};

const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization'];
  if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token.' });

    req.user = user;
    next();
  });
};

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  },
});

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

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.get('/', (req, res) => {
  res.send('Welcome to the backend server!');
});
// Get complaints with optional tag filter
app.get('/complaints', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { tag } = req.query;

    let query = supabase
      .from('complaints')
      .select('*, image_url') // Add image_url to selection
      .eq('user_id', userId);

    if (tag && VALID_TAGS.includes(tag)) {
      query = query.contains('tags', [tag]);
    }

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
app.post('/submit', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    const { title, description, tags } = req.body;
    const userId = req.user.id;

    // Validate basic fields
    if (!title || !description) {
      return res.status(400).json({ message: 'Title and description are required' });
    }

    // Parse tags properly
    let parsedTags = [];
    try {
      // Check if tags is already an array or a JSON string
      if (Array.isArray(tags)) {
        parsedTags = tags;
      } else if (typeof tags === 'string') {
        parsedTags = JSON.parse(tags);
      }
      
      // Filter to only include valid tags
      parsedTags = parsedTags.filter(tag => VALID_TAGS.includes(tag));
    } catch (error) {
      return res.status(400).json({ message: 'Invalid tags format' });
    }

    // Rest of the function remains the same...
    // Handle image if provided
    let imageUrl = null;
    if (req.file) {
      try {
        // Process image
        const processedImage = await processImage(req.file.buffer);
        
        // Generate unique filename
        const fileName = `${uuidv4()}.jpg`;
        
        // Upload to storage
        imageUrl = await uploadToStorage(processedImage, fileName);
      } catch (error) {
        console.error('Image handling error:', error);
        return res.status(500).json({ message: 'Error processing image', error: error.message });
      }
    }

    // Insert complaint with image URL
    const { data: complaint, error } = await supabase
      .from('complaints')
      .insert([{ 
        user_id: userId, 
        title, 
        description, 
        status: 'pending',
        tags: parsedTags,
        image_url: imageUrl
      }])
      .select('*');

    if (error) {
      console.error('Supabase Insert Error:', error);
      return res.status(500).json({ message: 'Error inserting complaint', error: error.message });
    }

    res.status(201).json({ 
      message: 'Complaint submitted successfully', 
      complaint: complaint[0]
    });
  } catch (error) {
    console.error('Unexpected Error:', error);
    res.status(500).json({ message: 'Unexpected error occurred', error: error.message });
  }
});


app.delete('/complaints/:id/image', authenticateToken, async (req, res) => {
  const complaintId = req.params.id;
  const userId = req.user.id;

  try {
    // Get complaint to verify ownership and get image URL
    const { data: complaint, error: fetchError } = await supabase
      .from('complaints')
      .select('user_id, image_url')
      .eq('id', complaintId)
      .single();

    if (fetchError || !complaint) {
      return res.status(404).json({ message: 'Complaint not found' });
    }

    // Verify ownership
    if (complaint.user_id !== userId) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    if (complaint.image_url) {
      // Extract filename from URL
      const fileName = complaint.image_url.split('/').pop();
      
      // Delete from storage
      const { error: deleteError } = await supabase
        .storage
        .from('complaint-images')
        .remove([`complaints/${fileName}`]);

      if (deleteError) {
        console.error('Storage delete error:', deleteError);
        return res.status(500).json({ message: 'Error deleting image' });
      }

      // Update complaint to remove image URL
      const { error: updateError } = await supabase
        .from('complaints')
        .update({ image_url: null })
        .eq('id', complaintId);

      if (updateError) {
        console.error('Database update error:', updateError);
        return res.status(500).json({ message: 'Error updating complaint' });
      }
    }

    res.json({ message: 'Image deleted successfully' });
  } catch (error) {
    console.error('Image deletion error:', error);
    res.status(500).json({ message: 'Error deleting image' });
  }
});

// Add this to your backend code
app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return res.status(401).json({ message: "Invalid credentials" });


  // Ensure admin metadata exists
  if (!data.user.user_metadata?.admin) {
    return res.status(403).json({ message: "Access denied: Admins only" });
  }

  // ✅ Generate Token with `isAdmin: true`
  const token = jwt.sign(
    { id: data.user.id, email: data.user.email, isAdmin: true },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  res.json({ message: "Login successful", token });
});

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

app.put("/admin/complaints/:id/status", isAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["pending", "working", "finished"].includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
  }

  const { error } = await supabase
      .from("complaints")
      .update({ status })
      .eq("id", id);

  if (error) {
      console.error("❌ Error updating complaint status:", error);
      return res.status(500).json({ error: error.message });
  }

  res.json({ message: `✅ Complaint marked as ${status}` });
});
// ✅ Secure Route: Delete a Complaint (Optional)
app.delete("/admin/complaints/:id", isAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("complaints").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ message: "Complaint deleted successfully" });
});

app.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    // Sign up user in Supabase authentication
    const { data: user, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) return res.status(400).json({ message: error.message });

    // Ensure user exists before inserting profile
    if (!user.user) return res.status(400).json({ message: 'User signup failed' });

    // Insert user profile into `profiles`
    const { error: profileError } = await supabase
      .from('profiles')
      .insert([{ user_id: user.user.id, display_name: name, email }]);

    if (profileError) return res.status(500).json({ message: 'Profile creation failed', error: profileError.message });

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

app.delete('/complaints/:id', async (req, res) => {
  const complaintId = req.params.id;
  const userId = req.user?.id; // Ensure user is authenticated

  try {
    // Find the complaint
    const { data: complaint, error: findError } = await supabase
      .from('complaints')
      .select('id, user_id')
      .eq('id', complaintId)
      .single();

    if (findError || !complaint) {
      return res.status(404).json({ error: 'Complaint not found' });
    }

    // Check if user is authorized to delete
    if (complaint.user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized to delete this complaint' });
    }

    // Delete the complaint
    const { error: deleteError } = await supabase
      .from('complaints')
      .delete()
      .eq('id', complaintId);

    if (deleteError) {
      return res.status(500).json({ error: 'Failed to delete complaint' });
    }

    res.status(200).json({ message: 'Complaint deleted successfully' });

  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const { data: profileArray, error } = await supabase
      .from('profiles')
      .select('display_name, user_id, email')
      .eq('user_id', userId); // removed .single()


    if (error) {
      console.error('Supabase Fetch Error:', error);
      return res.status(500).json({ message: 'Error fetching profile', error: error.message });
    }

    if (!profileArray || profileArray.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    const profile = profileArray[0]; // take the first result

    res.json({ 
      profile: {
        display_name: profile.display_name || 'User', 
        email: profile.email || 'No email provided',
        user_id: profile.user_id
      } 
    });

  } catch (error) {
    console.error('Unexpected Error:', error.message);
    res.status(500).json({ message: 'Unexpected error occurred', error: error.message });
  }
});

// Helper function to process and optimize images
async function processImage(buffer) {
  try {
    // Resize and optimize image
    const processedImage = await sharp(buffer)
      .resize(1200, 1200, { // Max dimensions
        fit: 'inside',
        withoutEnlargement: true
      })
      .jpeg({ quality: 80 }) // Convert to JPEG and compress
      .toBuffer();
    
    return processedImage;
  } catch (error) {
    console.error('Image processing error:', error);
    throw error;
  }
}

// Helper function to upload to Supabase Storage
async function uploadToStorage(imageBuffer, fileName) {
  try {
    const { data, error } = await supabase
      .storage
      .from('complaint-images')
      .upload(`complaints/${fileName}`, imageBuffer, {
        contentType: 'image/jpeg',
        cacheControl: '3600',
        upsert: false
      });

    if (error) throw error;

    // Get public URL
    const { data: { publicUrl } } = supabase
      .storage
      .from('complaint-images')
      .getPublicUrl(`complaints/${fileName}`);

    return publicUrl;
  } catch (error) {
    console.error('Storage upload error:', error);
    throw error;
  }
}

// Admin Profile Route
app.get('/admin/profile', authenticateAdmin, async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch admin details from Supabase `auth.users`
    const { data: user, error } = await supabase
      .from('auth.users') // Using Supabase authentication table
      .select('email, raw_user_meta_data')
      .eq('id', userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ message: 'Admin profile not found' });
    }

    res.json({
      email: user.email,
      display_name: user.raw_user_meta_data?.display_name || 'Admin',
      role: user.raw_user_meta_data?.admin ? 'admin' : 'user',
    });

  } catch (error) {
    console.error('Error fetching admin profile:', error);
    res.status(500).json({ message: 'Error fetching admin profile' });
  }
});

app.get('/admin/statistics', isAdmin, async (req, res) => {
  try {
    // Get total complaints
    const { count: totalCount, error: countError } = await supabase
      .from('complaints')
      .select('*', { count: 'exact', head: true }); // ✅ Fix: Uses correct Supabase syntax
    
    if (countError) throw countError;
    
    // Get counts by status
    const statuses = ['pending', 'working', 'finished'];
    const statusCounts = {};
    
    for (const status of statuses) {
      const { count, error } = await supabase
      .from('complaints')
      .select('*', { count: 'exact', head: true }) // ✅ Correct syntax
      .eq('status', status);
        
      if (error) throw error;
      statusCounts[status] = count;
    }
    
    // Get recent complaints
    const { data: recentComplaints, error: recentError } = await supabase
      .from('complaints')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);
      
    if (recentError) throw recentError;
    
    // Get complaints by tag
    const tagCounts = {};
    for (const tag of VALID_TAGS) {
      const { count, error } = await supabase
        .from('complaints')
        .select('*', { count: 'exact', head: true })
        .contains('tags', [tag]);
        
      if (error) throw error;
      tagCounts[tag] = count;
    }
    
    res.json({
      total: totalCount,
      byStatus: statusCounts,
      byTag: tagCounts,
      recent: recentComplaints
    });
  } catch (error) {
    console.error('Statistics Error:', error);
    res.status(500).json({ message: 'Error fetching statistics' });
  }
});

// Get complaint details by ID
app.get('/admin/complaints/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const { data, error } = await supabase
      .from('complaints')
      .select('*')
      .eq('id', id)
      .single();
      
    if (error) throw error;
    
    res.json(data);
  } catch (error) {
    console.error('Complaint Detail Error:', error);
    res.status(500).json({ message: 'Error fetching complaint details' });
  }
});

// Add comment to complaint (new feature)
app.post('/admin/complaints/:id/comment', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;
    
    if (!comment) {
      return res.status(400).json({ message: 'Comment is required' });
    }
    
    // Get existing comments
    const { data: complaint, error: fetchError } = await supabase
      .from('complaints')
      .select('admin_comments')
      .eq('id', id)
      .single();
      
    if (fetchError) throw fetchError;
    
    const comments = complaint.admin_comments || [];
    comments.push({
      text: comment,
      timestamp: new Date().toISOString(),
      admin_id: req.user.id
    });
    
    // Update complaint with new comment
    const { error: updateError } = await supabase
      .from('complaints')
      .update({ admin_comments: comments })
      .eq('id', id);
      
    if (updateError) throw updateError;
    
    res.json({ message: 'Comment added successfully', comments });
  } catch (error) {
    console.error('Comment Error:', error);
    res.status(500).json({ message: 'Error adding comment' });
  }
});

// Profile update endpoint
app.post('/profile/update', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id || req.user.sub;

    if (!userId) {
      return res.status(401).json({ message: 'Invalid token payload' });
    }

    const { display_name } = req.body;

    if (!display_name || typeof display_name !== 'string') {
      return res.status(400).json({ message: 'Display name is required' });
    }

    const { data: updatedProfiles, error } = await supabase
      .from('profiles')
      .update({ display_name })
      .eq('user_id', userId)
      .select(); // removed .single()

    if (error) {
      console.error('Supabase update error:', error.message);
      return res.status(500).json({ message: 'Failed to update profile', error: error.message });
    }

    if (!updatedProfiles || updatedProfiles.length === 0) {
      return res.status(404).json({ message: 'Profile not found' });
    }

    res.json(updatedProfiles[0]); // safely return the first
  } catch (err) {
    console.error('Profile Update Error:', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;