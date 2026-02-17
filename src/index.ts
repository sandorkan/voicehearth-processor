import "dotenv/config"
import express from "express"
import { processRecording } from "./pipeline"

const app = express()
app.use(express.json())

const API_KEY = process.env.API_KEY
if (!API_KEY) {
  console.error("API_KEY environment variable is required")
  process.exit(1)
}

// Auth middleware
function authenticate(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers.authorization
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    res.status(401).json({ success: false, error: "Unauthorized" })
    return
  }
  next()
}

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

// Process recording
app.post("/process", authenticate, async (req, res) => {
  const { sessionId, storyTitle, readerName, musicTrack, musicVolume, purchaseId } = req.body

  if (!sessionId || !storyTitle || !purchaseId) {
    res.status(400).json({
      success: false,
      error: "sessionId, storyTitle, and purchaseId are required",
    })
    return
  }

  // Respond immediately, process in background
  res.json({ success: true, message: "Processing started" })

  try {
    const audioPath = await processRecording({
      sessionId,
      storyTitle,
      readerName,
      musicTrack,
      musicVolume,
      purchaseId,
    })
    console.log(`Completed processing for session ${sessionId}: ${audioPath}`)
  } catch (error) {
    console.error(`Processing failed for session ${sessionId}:`, error)
    // Error already recorded in DB by pipeline.ts
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`VoiceHearth processor listening on port ${PORT}`)
})
