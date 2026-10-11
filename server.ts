
import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API to save user registration data
  app.post("/api/register", (req, res) => {
    const userData = req.body;
    const usersFilePath = path.join(__dirname, "users.json");

    let users = [];
    if (fs.existsSync(usersFilePath)) {
      try {
        const fileContent = fs.readFileSync(usersFilePath, "utf-8");
        users = JSON.parse(fileContent);
      } catch (e) {
        console.error("Error reading users.json", e);
      }
    }

    // Add timestamp and ID
    const newUser = {
      ...userData,
      id: Date.now().toString(),
      registeredAt: new Date().toISOString()
    };

    users.push(newUser);

    try {
      fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
      res.json({ success: true, user: newUser });
    } catch (e) {
      console.error("Error writing users.json", e);
      res.status(500).json({ success: false, error: "Failed to save user data" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
