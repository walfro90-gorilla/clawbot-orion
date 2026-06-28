// Fase B: imagen del post diario con "Nano Banana" (gemini-2.5-flash-image).
// 1) generateImagePrompt: convierte el post en un prompt de imagen (inglés, mejor calidad).
// 2) generateImage: genera la imagen (PNG base64) con Nano Banana.
// 3) uploadGeneratedImage: la sube a Supabase Storage (bucket público) y devuelve la URL.

import { GoogleGenAI } from '@google/genai'
import { supabase } from './supabase.js'

const IMAGE_MODEL = 'gemini-2.5-flash-image'
const BUCKET = 'published-posts'

// Prompt de imagen a partir del texto del post (punto #1 del usuario).
export async function generateImagePrompt(postText, agent) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  const sys =
    `You write ONE concise English prompt for an AI image generator, to accompany a LinkedIn post. ` +
    `Rules: professional, modern, clean editorial/corporate aesthetic; abstract or conceptual ` +
    `illustration; ABSOLUTELY NO text, words, letters, numbers, watermarks or logos in the image; ` +
    `describe subject, composition, style and color palette. Max 55 words. Output ONLY the prompt.`
  const user = `Post:\n${postText}\n\nBusiness context: ${agent?.business_context || ''}`
  const resp = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    config: { systemInstruction: sys, temperature: 0.7, maxOutputTokens: 160, thinkingConfig: { thinkingBudget: 0 } },
    contents: user,
  })
  return (resp?.text || '').trim().replace(/^["'`]+|["'`]+$/g, '')
}

// Genera la imagen con Nano Banana → { base64, mime }.
export async function generateImage(imagePrompt) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  const resp = await ai.models.generateContent({ model: IMAGE_MODEL, contents: imagePrompt })
  const parts = resp?.candidates?.[0]?.content?.parts || []
  for (const p of parts) {
    if (p?.inlineData?.data) return { base64: p.inlineData.data, mime: p.inlineData.mimeType || 'image/png' }
  }
  throw new Error('no_image_in_response')
}

// Sube la imagen al bucket público y devuelve la URL pública.
export async function uploadGeneratedImage(base64, mime, accountId, postId) {
  const buffer = Buffer.from(base64, 'base64')
  const ext = (mime || '').includes('jpeg') ? 'jpg' : 'png'
  const path = `${accountId}/${postId}.${ext}`
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mime || 'image/png', upsert: true })
  if (error) throw new Error('upload_failed_' + error.message)
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}
