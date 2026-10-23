"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Award,
  Check,
  Copy,
  Image as ImageIcon,
  MapPin,
  Scan,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { apiErrorMessage, readApiResponse } from "@/lib/api-response";
import type { Task } from "@/lib/types";

const VISION_FEATURES = [
  "LABEL_DETECTION",
  "TEXT_DETECTION",
  "LOGO_DETECTION",
  "LANDMARK_DETECTION",
  "FACE_DETECTION",
  "SAFE_SEARCH_DETECTION",
] as const;
type VisionFeature = typeof VISION_FEATURES[number];
type Category = "workspace" | "events" | "team" | "documents";
type Likelihood = "UNKNOWN" | "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY";
type VisionAnalysis = {
  id: string;
  analysisId: string;
  title: string;
  category: Category;
  imageUrl?: string;
  featuresRequested: VisionFeature[];
  labelAnnotations: Array<{ description: string; score: number; topicality?: number }>;
  fullTextAnnotation: { text: string; lines: string[] } | null;
  logoAnnotations: Array<{ description: string; score: number }>;
  landmarkAnnotations: Array<{ description: string; score: number; latitude?: number; longitude?: number }>;
  faceAnnotations: Array<{
    faceIndex: number;
    confidence: number;
    joyLikelihood: string;
    surpriseLikelihood: string;
    sorrowLikelihood: string;
    angerLikelihood: string;
    headwearLikelihood: string;
  }>;
  safeSearchAnnotation: {
    adult: string;
    spoof: string;
    medical: string;
    violence: string;
    racy: string;
    isSafe: boolean;
  };
  executionEngine: string;
  createdAt: string;
};
type VisionResponse = {
  ok: boolean;
  analyses?: VisionAnalysis[];
  analysis?: VisionAnalysis;
  task?: Task;
  error?: string;
  deleted?: boolean;
};
type ViewTab = "presets" | "upload" | "url" | "history";
type ResultTab = "labels" | "ocr" | "logos" | "landmarks" | "faces" | "safe-search";

const PRESETS: Array<{ title: string; category: Category; image: string; description: string }> = [
  {
    title: "Architecture & OCR Whiteboard",
    category: "workspace",
    image: "https://images.unsplash.com/photo-1531403009284-440f080d1e12?w=1200&auto=format&fit=crop&q=80",
    description: "Extract text and ideas from a planning workspace.",
  },
  {
    title: "Tech Keynote & Brand Logos",
    category: "events",
    image: "https://images.unsplash.com/photo-1511578314322-379afb476865?w=1200&auto=format&fit=crop&q=80",
    description: "Inspect an event scene for labels and logos.",
  },
  {
    title: "Golden Gate Landmark",
    category: "documents",
    image: "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=1200&auto=format&fit=crop&q=80",
    description: "Identify landmarks and geographic coordinates.",
  },
  {
    title: "Executive Team Portrait",
    category: "team",
    image: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=1200&auto=format&fit=crop&q=80",
    description: "Inspect team imagery and safety signals.",
  },
];

const FEATURE_LABELS: Record<VisionFeature, string> = {
  LABEL_DETECTION: "Labels",
  TEXT_DETECTION: "OCR Text",
  LOGO_DETECTION: "Logos",
  LANDMARK_DETECTION: "Landmarks",
  FACE_DETECTION: "Faces",
  SAFE_SEARCH_DETECTION: "SafeSearch",
};

const RESULT_TABS: Array<{ id: ResultTab; label: string }> = [
  { id: "labels", label: "Labels" },
  { id: "ocr", label: "OCR Text" },
  { id: "logos", label: "Logos" },
  { id: "landmarks", label: "Landmarks" },
  { id: "faces", label: "Faces" },
  { id: "safe-search", label: "SafeSearch" },
];

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function confidencePercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

export function CloudVisionView({
  onNotify,
  onTaskCreated,
}: {
  onNotify?: (message: string, tone?: "success" | "error" | "info") => void;
  onTaskCreated?: (task: Task) => void;
}) {
  const [history, setHistory] = useState<VisionAnalysis[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [viewTab, setViewTab] = useState<ViewTab>("presets");
  const [resultTab, setResultTab] = useState<ResultTab>("labels");
  const [features, setFeatures] = useState<VisionFeature[]>([...VISION_FEATURES]);
  const [image, setImage] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("workspace");
  const [urlInput, setUrlInput] = useState("");
  const [uploadName, setUploadName] = useState("");
  const [selectedAnalysis, setSelectedAnalysis] = useState<VisionAnalysis | null>(null);
  const [running, setRunning] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const response = await fetch("/api/vision/analyze?limit=20", { cache: "no-store" });
      const result = await readApiResponse<VisionResponse>(response);
      if (!response.ok || !result.ok || !Array.isArray(result.analyses)) {
        throw new Error(result.error ?? "Saved scans could not be loaded.");
      }
      setHistory(result.analyses);
    } catch (loadError) {
      onNotify?.(apiErrorMessage(loadError, "Saved scans could not be loaded."), "error");
    } finally {
      setLoadingHistory(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const current = selectedAnalysis;
  const safeImage = safeHttpsUrl(current?.imageUrl);

  const activeSource = useMemo(() => {
    if (viewTab === "url") return urlInput.trim();
    return image;
  }, [image, urlInput, viewTab]);

  function selectPreset(preset: typeof PRESETS[number]) {
    setImage(preset.image);
    setTitle(preset.title);
    setCategory(preset.category);
    setUploadName("");
    setSelectedAnalysis(null);
    setViewTab("presets");
    setError("");
  }

  function toggleFeature(feature: VisionFeature) {
    setFeatures((currentFeatures) => currentFeatures.includes(feature)
      ? currentFeatures.filter((item) => item !== feature)
      : [...currentFeatures, feature]);
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
      setError("Choose a PNG, JPEG, WebP, or GIF image.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError("Image uploads must be 4 MB or smaller.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError("The selected image could not be read.");
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        setError("The selected image could not be read.");
        return;
      }
      setImage(reader.result);
      setTitle(file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Uploaded image");
      setCategory("workspace");
      setUploadName(file.name);
      setSelectedAnalysis(null);
      setError("");
    };
    reader.readAsDataURL(file);
  }

  async function runScan() {
    const source = activeSource;
    if (!source) {
      setError(viewTab === "url" ? "Enter an HTTPS image URL." : "Select an image to scan.");
      return;
    }
    if (viewTab === "url" && !safeHttpsUrl(source)) {
      setError("Enter a valid HTTPS image URL.");
      return;
    }
    if (!features.length) {
      setError("Select at least one detection feature.");
      return;
    }
    setRunning(true);
    setError("");
    try {
      const response = await fetch("/api/vision/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: source, features, title: title || "Vision scan", category }),
      });
      const result = await readApiResponse<VisionResponse>(response);
      if (!response.ok || !result.ok || !result.analysis) {
        throw new Error(result.error ?? "Image analysis failed.");
      }
      setSelectedAnalysis(result.analysis);
      setResultTab("labels");
      setHistory((currentHistory) => [
        result.analysis!,
        ...currentHistory.filter((item) => item.analysisId !== result.analysis!.analysisId),
      ].slice(0, 20));
      setViewTab("history");
      onNotify?.("Vision scan saved to MongoDB.");
    } catch (scanError) {
      const message = apiErrorMessage(scanError, "Image analysis failed.");
      setError(message);
      onNotify?.(message, "error");
    } finally {
      setRunning(false);
    }
  }

  async function deleteAnalysis(analysisId: string) {
    setDeletingId(analysisId);
    try {
      const response = await fetch("/api/vision/analyze", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analysisId }),
      });
      const result = await readApiResponse<VisionResponse>(response);
      if (!response.ok || !result.ok || !result.deleted) {
        throw new Error(result.error ?? "Saved scan could not be deleted.");
      }
      setHistory((currentHistory) => currentHistory.filter((item) => item.analysisId !== analysisId));
      if (selectedAnalysis?.analysisId === analysisId) setSelectedAnalysis(null);
      onNotify?.("Saved scan deleted.");
    } catch (deleteError) {
      onNotify?.(apiErrorMessage(deleteError, "Saved scan could not be deleted."), "error");
    } finally {
      setDeletingId("");
    }
  }

  async function copyOcrText() {
    const text = current?.fullTextAnnotation?.text ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (copyError) {
      onNotify?.(apiErrorMessage(copyError, "OCR text could not be copied."), "error");
    }
  }

  async function createTaskFromOcr() {
    const fullText = current?.fullTextAnnotation?.text;
    if (!fullText?.trim()) return;
    setCreatingTask(true);
    try {
      const firstLine = fullText.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Extracted text";
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `OCR: ${firstLine}`.slice(0, 2_000), notes: fullText }),
      });
      const result = await readApiResponse<VisionResponse>(response);
      if (!response.ok || !result.ok || !result.task) {
        throw new Error(result.error ?? "Planner task could not be created.");
      }
      onTaskCreated?.(result.task);
      onNotify?.("OCR text saved as a Planner task.");
    } catch (taskError) {
      onNotify?.(apiErrorMessage(taskError, "Planner task could not be created."), "error");
    } finally {
      setCreatingTask(false);
    }
  }

  function renderResult() {
    if (!current) {
      return <div className="vision-result-empty"><ImageIcon size={24} /><strong>No scan selected</strong><span>Choose an image and run a scan, or select a saved result.</span></div>;
    }
    if (resultTab === "labels") {
      return current.labelAnnotations.length ? (
        <div className="vision-annotation-list">
          {current.labelAnnotations.map((label, index) => {
            const percent = confidencePercent(label.score);
            return <article className="vision-label-row" key={`${label.description}-${index}`}>
              <div><strong>{label.description}</strong><span>{percent}%</span></div>
              <div className="vision-label-bar"><i style={{ width: `${percent}%` }} /></div>
            </article>;
          })}
        </div>
      ) : <p className="vision-no-data">No labels were returned for this scan.</p>;
    }
    if (resultTab === "ocr") {
      const text = current.fullTextAnnotation?.text ?? "";
      return <div className="vision-ocr">
        {text ? <>
          <div className="vision-ocr-actions">
            <button className="refresh-button" type="button" onClick={() => void copyOcrText()}><Copy size={13} />{copied ? "Copied" : "Copy Text"}</button>
            <button className="vision-primary-button" type="button" onClick={() => void createTaskFromOcr()} disabled={creatingTask}>
              {creatingTask ? "Creating task…" : "Create Planner Task from OCR"}
            </button>
          </div>
          <pre className="vision-ocr-full">{text}</pre>
          <ol className="vision-ocr-lines">{current.fullTextAnnotation?.lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ol>
        </> : <p className="vision-no-data">No text was detected for this scan.</p>}
      </div>;
    }
    if (resultTab === "logos") {
      return current.logoAnnotations.length
        ? <div className="vision-annotation-list">{current.logoAnnotations.map((logo, index) =>
          <article className="vision-logo-row" key={`${logo.description}-${index}`}><Award size={16} /><strong>{logo.description}</strong><span>{confidencePercent(logo.score)}%</span></article>)}</div>
        : <p className="vision-no-data">No logos were detected.</p>;
    }
    if (resultTab === "landmarks") {
      return current.landmarkAnnotations.length
        ? <div className="vision-annotation-list">{current.landmarkAnnotations.map((landmark, index) => {
          const hasCoordinates = Number.isFinite(landmark.latitude) && Number.isFinite(landmark.longitude) &&
            Math.abs(landmark.latitude!) <= 90 && Math.abs(landmark.longitude!) <= 180;
          const mapUrl = hasCoordinates
            ? `https://www.google.com/maps/search/?api=1&query=${landmark.latitude},${landmark.longitude}`
            : undefined;
          return <article className="vision-landmark-row" key={`${landmark.description}-${index}`}>
            <MapPin size={16} /><div><strong>{landmark.description}</strong>
              {hasCoordinates && <span>{landmark.latitude}, {landmark.longitude}</span>}</div>
            {mapUrl && <a href={mapUrl} target="_blank" rel="noopener noreferrer">Open map</a>}
          </article>;
        })}</div>
        : <p className="vision-no-data">No landmarks were detected.</p>;
    }
    if (resultTab === "faces") {
      return current.faceAnnotations.length
        ? <div className="vision-face-grid">{current.faceAnnotations.map((face) =>
          <article className="vision-face-card" key={face.faceIndex}><strong>Face {face.faceIndex + 1}</strong>
            <span>Confidence {confidencePercent(face.confidence)}%</span>
            {(["joyLikelihood", "surpriseLikelihood", "sorrowLikelihood", "angerLikelihood", "headwearLikelihood"] as const)
              .map((field) => <span className="vision-likelihood-badge" key={field}>{field.replace("Likelihood", "")}: {face[field]}</span>)}
          </article>)}</div>
        : <p className="vision-no-data">No faces were detected.</p>;
    }
    const safety = current.safeSearchAnnotation;
    return <div className="vision-safety">
      <span className={`vision-safety-status ${safety.isSafe ? "is-safe" : "needs-review"}`}>
        <ShieldCheck size={16} />{safety.isSafe ? "SafeSearch: compliant" : "SafeSearch: review recommended"}
      </span>
      <div className="vision-safety-grid">
        {(["adult", "spoof", "medical", "violence", "racy"] as const).map((field) =>
          <article key={field}><span>{field}</span><strong className="vision-likelihood-badge">{safety[field] as Likelihood}</strong></article>)}
      </div>
    </div>;
  }

  return (
    <section className="vision-view">
      <header className="panel vision-intro">
        <div className="vision-intro-title"><span className="vision-intro-icon"><Scan size={20} /></span>
          <div><span className="insight-eyebrow">MULTI-MODAL IMAGE INSPECTOR</span><h2>Google Cloud Vision</h2>
            <p>Inspect workspace images, extract text, and keep user-scoped scan history in MongoDB.</p></div>
        </div>
        <span className="vision-storage-badge">Permanent MongoDB history</span>
      </header>

      <div className="panel vision-source-panel">
        <div className="panel-heading"><div><h2>Image source</h2><p>Choose a preset, upload a local image, or provide an HTTPS URL.</p></div></div>
        <div className="vision-tabs" role="tablist" aria-label="Image source">
          {([
            ["presets", "Preset Scenarios"],
            ["upload", "Upload Device Image"],
            ["url", "Image URL"],
            ["history", "Saved MongoDB Scans"],
          ] as Array<[ViewTab, string]>).map(([id, label]) =>
            <button key={id} type="button" role="tab" aria-selected={viewTab === id} className={viewTab === id ? "is-active" : ""} onClick={() => {
              setViewTab(id);
              setSelectedAnalysis(id === "history" ? selectedAnalysis : null);
              setError("");
            }}>{label}{id === "history" && <span>{history.length}</span>}</button>)}
        </div>

        {viewTab === "presets" && <div className="vision-presets-grid">
          {PRESETS.map((preset) => {
            const active = image === preset.image;
            return <button type="button" className={`vision-preset-card ${active ? "is-selected" : ""}`} key={preset.title} onClick={() => selectPreset(preset)}>
              <img src={preset.image} alt="" loading="lazy" referrerPolicy="no-referrer" />
              <span><strong>{preset.title}</strong><small>{preset.description}</small></span>
            </button>;
          })}
        </div>}

        {viewTab === "upload" && <div className="vision-upload-zone">
          <ImageIcon size={24} /><strong>{uploadName || "Upload an image from your device"}</strong>
          <span>PNG, JPEG, WebP, or GIF · 4 MB maximum</span>
          <label className="vision-primary-button upload-picker">Choose image
            <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void chooseFile(event.currentTarget.files?.[0])} />
          </label>
        </div>}

        {viewTab === "url" && <div className="vision-url-input">
          <label className="workspace-field"><span>HTTPS image URL</span><input type="url" inputMode="url" placeholder="https://example.com/image.jpg" value={urlInput} onChange={(event) => {
            setUrlInput(event.target.value);
            setImage("");
            setSelectedAnalysis(null);
          }} /></label>
          <label className="workspace-field"><span>Scan title</span><input maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Image scan" /></label>
        </div>}

        {viewTab === "history" && <div className="vision-history">
          {loadingHistory ? <p className="vision-no-data">Loading saved scans…</p> : history.length === 0
            ? <p className="vision-no-data">No saved scans yet. Run a scan to build your history.</p>
            : history.map((analysis) => <article className={`vision-history-card ${selectedAnalysis?.analysisId === analysis.analysisId ? "is-selected" : ""}`} key={analysis.analysisId}>
              <button type="button" onClick={() => {
                setSelectedAnalysis(analysis);
                setResultTab("labels");
              }}>
                {safeHttpsUrl(analysis.imageUrl)
                  ? <img src={safeHttpsUrl(analysis.imageUrl)} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  : <span className="vision-history-placeholder"><ImageIcon size={18} /></span>}
                <span><strong>{analysis.title}</strong><small>{new Date(analysis.createdAt).toLocaleString()}</small></span>
              </button>
              <button type="button" className="icon-action danger" onClick={() => void deleteAnalysis(analysis.analysisId)} disabled={deletingId === analysis.analysisId} aria-label={`Delete scan ${analysis.title}`}>
                <Trash2 size={14} />
              </button>
            </article>)}
        </div>}

        {viewTab !== "history" && <>
          <div className="vision-feature-row">
            <strong>Detection features</strong>
            {VISION_FEATURES.map((feature) => <button key={feature} type="button" className={`vision-feature-chip ${features.includes(feature) ? "is-enabled" : ""}`} aria-pressed={features.includes(feature)} onClick={() => toggleFeature(feature)}>
              {features.includes(feature) && <Check size={12} />}{FEATURE_LABELS[feature]}
            </button>)}
          </div>
          <div className="vision-run-row">
            {error && <p className="contacts-error" role="alert">{error}</p>}
            <button className="vision-primary-button" type="button" onClick={() => void runScan()} disabled={running}>
              <Scan size={15} />{running ? "Analyzing image…" : "Run Vision Scan"}
            </button>
          </div>
        </>}
      </div>

      {current && <section className="panel vision-inspector">
        <div className="panel-heading">
          <div><span className="insight-eyebrow">ANALYSIS RESULTS</span><h2>{current.title}</h2><p>{current.category} · {new Date(current.createdAt).toLocaleString()}</p></div>
          <span className="vision-engine-badge">{current.executionEngine}</span>
        </div>
        {safeImage && <img className="vision-result-image" src={safeImage} alt={`Scanned image: ${current.title}`} referrerPolicy="no-referrer" />}
        <div className="vision-tabs vision-result-tabs" role="tablist" aria-label="Analysis results">
          {RESULT_TABS.map((tab) => <button type="button" role="tab" aria-selected={resultTab === tab.id} className={resultTab === tab.id ? "is-active" : ""} key={tab.id} onClick={() => setResultTab(tab.id)}>{tab.label}</button>)}
        </div>
        <div className="vision-result-content">{renderResult()}</div>
      </section>}
    </section>
  );
}
