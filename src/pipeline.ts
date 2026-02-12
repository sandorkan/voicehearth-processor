import fs from "fs"
import path from "path"
import Ffmpeg from "fluent-ffmpeg"
import { getSupabase } from "./supabase"

const PAGE_GAP_SECONDS = 0.75

type ProcessingStep =
  | "downloading"
  | "stitching"
  | "polishing"
  | "mixing_music"
  | "encoding"
  | "uploading"

interface ProcessOptions {
  sessionId: string
  storyTitle: string
  readerName?: string
  musicTrack?: string
  purchaseId: string
}

async function updateStep(purchaseId: string, step: ProcessingStep) {
  const supabase = getSupabase()
  await supabase
    .from("purchases")
    .update({ processing_step: step })
    .eq("id", purchaseId)
}

async function markFailed(purchaseId: string, error: string) {
  const supabase = getSupabase()
  await supabase
    .from("purchases")
    .update({
      processing_status: "failed",
      error_message: error,
    })
    .eq("id", purchaseId)
}

async function markCompleted(purchaseId: string, audioPath: string) {
  const supabase = getSupabase()
  await supabase
    .from("purchases")
    .update({
      processing_status: "completed",
      final_audio_url: audioPath,
    })
    .eq("id", purchaseId)
}

function runFfmpeg(command: Ffmpeg.FfmpegCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    command
      .on("end", () => resolve())
      .on("error", (err) => reject(err))
      .run()
  })
}

function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    Ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err)
      resolve(metadata.format.duration || 0)
    })
  })
}

export async function processRecording(options: ProcessOptions): Promise<string> {
  const { sessionId, storyTitle, readerName, musicTrack, purchaseId } = options
  const supabase = getSupabase()
  const tmpDir = path.join("/tmp", sessionId)

  try {
    // Ensure clean working directory
    fs.mkdirSync(tmpDir, { recursive: true })

    // --- Step 1: Download pages ---
    await updateStep(purchaseId, "downloading")

    const { data: pages, error: pagesError } = await supabase
      .from("recording_pages")
      .select("page_index, audio_url, duration_seconds")
      .eq("session_id", sessionId)
      .not("audio_url", "is", null)
      .order("page_index", { ascending: true })

    if (pagesError || !pages || pages.length === 0) {
      throw new Error("No recording pages found for session")
    }

    // Download each page and convert to WAV
    const wavFiles: string[] = []
    for (const page of pages) {
      const { data: signedUrlData, error: urlError } = await supabase.storage
        .from("recordings")
        .createSignedUrl(page.audio_url!, 300)

      if (urlError || !signedUrlData?.signedUrl) {
        throw new Error(`Failed to get signed URL for page ${page.page_index}`)
      }

      const response = await fetch(signedUrlData.signedUrl)
      if (!response.ok) {
        throw new Error(`Failed to download page ${page.page_index}`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      const rawPath = path.join(tmpDir, `page-${page.page_index}.raw`)
      fs.writeFileSync(rawPath, buffer)

      // Convert to WAV (normalize format)
      const wavPath = path.join(tmpDir, `page-${page.page_index}.wav`)
      await runFfmpeg(
        Ffmpeg(rawPath)
          .audioChannels(1)
          .audioFrequency(44100)
          .format("wav")
          .output(wavPath)
      )
      wavFiles.push(wavPath)
    }

    // --- Step 2: Generate silence and concat ---
    await updateStep(purchaseId, "stitching")

    const silencePath = path.join(tmpDir, "silence.wav")
    await runFfmpeg(
      Ffmpeg()
        .input("anullsrc=r=44100:cl=mono")
        .inputFormat("lavfi")
        .duration(PAGE_GAP_SECONDS)
        .audioChannels(1)
        .audioFrequency(44100)
        .format("wav")
        .output(silencePath)
    )

    // Build concat file list
    const concatListPath = path.join(tmpDir, "concat.txt")
    const concatEntries: string[] = []
    for (let i = 0; i < wavFiles.length; i++) {
      concatEntries.push(`file '${wavFiles[i]}'`)
      if (i < wavFiles.length - 1) {
        concatEntries.push(`file '${silencePath}'`)
      }
    }
    fs.writeFileSync(concatListPath, concatEntries.join("\n"))

    const concatenatedPath = path.join(tmpDir, "concatenated.wav")
    await runFfmpeg(
      Ffmpeg()
        .input(concatListPath)
        .inputOptions(["-f", "concat", "-safe", "0"])
        .audioChannels(1)
        .audioFrequency(44100)
        .format("wav")
        .output(concatenatedPath)
    )

    // --- Step 3: Apply audio filters (highpass + loudnorm) ---
    await updateStep(purchaseId, "polishing")

    const polishedPath = path.join(tmpDir, "polished.wav")
    await runFfmpeg(
      Ffmpeg(concatenatedPath)
        .audioFilters([
          "highpass=f=80",
          "loudnorm=I=-16:TP=-1.5:LRA=11",
        ])
        .audioChannels(1)
        .audioFrequency(44100)
        .format("wav")
        .output(polishedPath)
    )

    // --- Step 4: Mix background music (if selected) ---
    let inputForEncode = polishedPath

    if (musicTrack) {
      await updateStep(purchaseId, "mixing_music")

      const appUrl = process.env.APP_URL
      const musicUrl = `${appUrl}/music/${musicTrack}.mp3`

      const musicResponse = await fetch(musicUrl)
      if (musicResponse.ok) {
        const musicBuffer = Buffer.from(await musicResponse.arrayBuffer())
        const musicPath = path.join(tmpDir, "music.mp3")
        fs.writeFileSync(musicPath, musicBuffer)

        // Get voice duration to know how long to make the mix
        const voiceDuration = await getAudioDuration(polishedPath)

        const mixedPath = path.join(tmpDir, "mixed.wav")
        await runFfmpeg(
          Ffmpeg()
            .input(polishedPath)
            .input(musicPath)
            .complexFilter([
              // Loop music if shorter, trim to voice length, fade in/out
              `[1:a]aloop=loop=-1:size=2e+09,atrim=duration=${voiceDuration},afade=t=in:st=0:d=3,afade=t=out:st=${Math.max(0, voiceDuration - 5)}:d=5,volume=0.1[music]`,
              // Mix voice (full volume) with quiet music
              `[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[out]`,
            ])
            .outputOptions(["-map", "[out]"])
            .audioChannels(1)
            .audioFrequency(44100)
            .format("wav")
            .output(mixedPath)
        )
        inputForEncode = mixedPath
      }
      // If music download fails, continue without music
    }

    // --- Step 5: Encode to MP3 ---
    await updateStep(purchaseId, "encoding")

    const mp3Path = path.join(tmpDir, "output.mp3")
    const metadata: string[] = [
      `-metadata`, `title=${storyTitle}`,
      `-metadata`, `album=VoiceHearth`,
    ]
    if (readerName) {
      metadata.push(`-metadata`, `artist=Read by ${readerName}`)
    }

    await runFfmpeg(
      Ffmpeg(inputForEncode)
        .audioBitrate("192k")
        .audioChannels(1)
        .audioFrequency(44100)
        .format("mp3")
        .outputOptions(metadata)
        .output(mp3Path)
    )

    // --- Step 6: Upload to Supabase Storage ---
    await updateStep(purchaseId, "uploading")

    const outputStoragePath = `processed/${sessionId}.mp3`
    const mp3Data = fs.readFileSync(mp3Path)

    const { error: uploadError } = await supabase.storage
      .from("recordings")
      .upload(outputStoragePath, mp3Data, {
        contentType: "audio/mpeg",
        upsert: true,
      })

    if (uploadError) {
      throw new Error(`Failed to upload processed MP3: ${uploadError.message}`)
    }

    // Mark as completed
    await markCompleted(purchaseId, outputStoragePath)

    return outputStoragePath
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown processing error"
    console.error(`Processing failed for session ${sessionId}:`, message)
    await markFailed(purchaseId, message)
    throw error
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  }
}
