import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import useSWR, { useSWRConfig } from "swr";
import { UnsavedChangesModal, useEditBlocker } from "../hooks/useEditBlocker";
import useFileToolbar from "../hooks/useFileToolbar";
import { fetcher } from "../utils/fetcher";
import {
  showErrorToast,
  showInfoToast,
  showSuccessToast,
} from "../utils/toast";
import Button from "./Button";
import ErrorDisplay from "./ErrorDisplay";
import Modal from "./Modal";
import BinaryFileViewer from "./viewers/BinaryFileViewer";
import ImageViewer from "./viewers/ImageViewer";
import MediaViewer from "./viewers/MediaViewer";
import TextViewer from "./viewers/TextViewer";

// MarkdownViewer is code-split because react-markdown + katex + remark/rehype
// plugins are too large to bundle eagerly. While the lazy chunk loads, we
// show a skeleton of text lines instead of a spinner to avoid an
// identical-looking spinner in the preceding useSWR-loading phase — two
// back-to-back spinners would cause a visual glitch where the animation
// resets when React swaps the DOM nodes.
const MarkdownViewer = lazy(() => import("./viewers/MarkdownViewer"));

function MarkdownSkeleton() {
  const lines = [
    "w-3/4",
    "w-full",
    "w-1/2",
    "w-5/6",
    "w-2/3",
    "w-full",
    "w-1/3",
    "w-4/5",
    "w-3/5",
    "w-full",
    "w-1/4",
    "w-2/3",
    "w-5/6",
    "w-1/2",
    "w-3/4",
  ];
  return (
    <div className="flex-1 p-6 animate-pulse">
      <div className="max-w-full space-y-3">
        {lines.map((w, i) => (
          <div key={i} className={`h-4 bg-gray-800 rounded ${w}`} />
        ))}
      </div>
    </div>
  );
}

// How far `el` is scrolled, as a fraction of how far it can scroll: 0 at the
// top, 1 at the bottom. An element that can't scroll counts as being at the top.
function getScrollRatio(el) {
  const maxScroll = el.scrollHeight - el.clientHeight;
  return maxScroll > 0 ? el.scrollTop / maxScroll : 0;
}

// Inverse of getScrollRatio: scrolls `el` to the given fraction.
function setScrollRatio(el, ratio) {
  el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
}

export default function FileViewer({ file }) {
  const { mutate } = useSWRConfig();
  const infoKey = `/api/files/info?file=${encodeURIComponent(file)}`;
  const { data: info, isLoading, error } = useSWR(infoKey);
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bookmarking, setBookmarking] = useState(false);
  const fileContentRef = useRef(null);
  const originalContentRef = useRef("");
  const [showFileNameModal, setShowFileNameModal] = useState(false);
  const [showConflictModal, setShowConflictModal] = useState(false);

  const rootRef = useRef(null);
  // Viewer scroll position when Edit was clicked, as a ratio (used to place
  // the textarea) and in pixels (used to return there exactly on Cancel).
  const scrollRatioRef = useRef(0);
  const viewScrollTopRef = useRef(0);
  // Where to scroll the viewer once it is shown again after leaving edit mode:
  // `{ top }` for an exact pixel offset, `{ ratio }` for a fraction, or null
  // when there is nothing to restore.
  const pendingViewScrollRef = useRef(null);

  // The viewer doesn't scroll itself: the layout's <main> does. The textarea,
  // on the other hand, scrolls itself, so pixel offsets can't be carried
  // between the two; only ratios can.
  const getViewScroller = useCallback(
    () => rootRef.current?.closest("main"),
    [],
  );

  const handleEdit = useCallback(() => {
    const scroller = getViewScroller();
    scrollRatioRef.current = scroller ? getScrollRatio(scroller) : 0;
    viewScrollTopRef.current = scroller?.scrollTop ?? 0;
    setEditMode(true);
  }, [getViewScroller]);

  const handleCancel = useCallback(() => {
    // The content is unchanged, so the viewer lays out as before and the
    // saved pixel offset brings the user back to the same spot.
    pendingViewScrollRef.current = { top: viewScrollTopRef.current };
    setEditMode(false);
  }, []);

  // useLayoutEffect rather than useEffect so the viewer is scrolled before the
  // browser paints it, avoiding a visible jump from the top. It runs after
  // MarkdownViewer's own layout effect (children run first), so this scroll
  // also wins over its scroll-to-#hash on mount.
  useLayoutEffect(() => {
    const pending = pendingViewScrollRef.current;
    if (editMode || !pending) return;
    pendingViewScrollRef.current = null;

    const scroller = getViewScroller();
    if (!scroller) return;
    if (pending.top !== undefined) scroller.scrollTop = pending.top;
    else setScrollRatio(scroller, pending.ratio);
  }, [editMode, getViewScroller]);

  useEffect(() => {
    const textarea = fileContentRef.current;
    if (!textarea || !editMode) return;
    originalContentRef.current = info.content;
    textarea.value = info.content;

    // Put the caret at the start of the line found at the same relative
    // position in the text, then scroll to the same relative position.
    // Rendered markdown and raw text don't line up exactly, so the result is
    // only close to where the user was reading.
    const ratio = scrollRatioRef.current;
    const offset = Math.round(ratio * info.content.length);
    // Move back to the start of the line containing `offset`. Searching from
    // `offset - 1` keeps the caret in place when `offset` already starts a
    // line, and `+ 1` turns "no newline found" (-1) into the start of the text.
    const caret = info.content.lastIndexOf("\n", offset - 1) + 1;
    // preventScroll stops the browser from scrolling on focus; the scroll
    // position is set explicitly below.
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(caret, caret);
    setScrollRatio(textarea, ratio);
  }, [editMode, info?.content]);

  const saveFile = useCallback(
    async (force) => {
      // Record where the textarea is scrolled right now. This can't wait until
      // the save succeeds: when the text changed, refreshing the file info below
      // re-runs the effect that fills the textarea, and that effect scrolls it
      // back to where editing began.
      const textareaScrollRatio = getScrollRatio(fileContentRef.current);
      setSaving(true);
      setShowConflictModal(false);

      try {
        const formData = new FormData();
        formData.append("file", file);
        formData.append(
          "content",
          new Blob([fileContentRef.current.value], { type: "text/plain" }),
          file,
        );
        formData.append("mtime", info.mtime);
        formData.append("force", force);

        const saveData = await fetcher("/api/files/content", {
          method: "PUT",
          body: formData,
        });

        await mutate(infoKey);

        saveData.modified
          ? showSuccessToast("Updated")
          : showInfoToast("No changes");
        // The saved text may have changed length, so a pixel offset would be
        // meaningless; reuse the textarea's ratio for an approximate position.
        pendingViewScrollRef.current = { ratio: textareaScrollRatio };
        setEditMode(false);
      } catch (err) {
        if (err.code === "VERSION_CONFLICT") {
          setShowConflictModal(true);
          return;
        }
        showErrorToast(err.message);
      } finally {
        setSaving(false);
      }
    },
    [file, info, infoKey, mutate],
  );

  const handleTrySave = useCallback(() => saveFile(false), [saveFile]);
  const handleSaveForce = useCallback(() => saveFile(true), [saveFile]);

  const isDirty = useCallback(() => {
    if (!editMode || !fileContentRef.current) return false;
    return fileContentRef.current.value !== originalContentRef.current;
  }, [editMode, fileContentRef, originalContentRef]);

  const blocker = useEditBlocker({
    enabled: editMode,
    hasUnsavedChanges: isDirty,
  });

  const handleToggleBookmark = useCallback(async () => {
    setBookmarking(true);

    try {
      const data = await fetcher("/api/bookmarks", {
        method: info.isBookmarked ? "DELETE" : "POST",
        body: { path: file },
      });

      await mutate(
        infoKey,
        { ...info, isBookmarked: data.isBookmarked },
        { revalidate: false },
      );
    } catch (err) {
      showErrorToast(err.message);
    } finally {
      setBookmarking(false);
    }
  }, [file, info, infoKey, mutate]);

  useFileToolbar({
    file,
    loading: isLoading,
    info,
    editMode,
    saving,
    bookmarking,
    showFileNameModal,
    onShowFileNameModal: setShowFileNameModal,
    onEdit: handleEdit,
    onCancel: handleCancel,
    onSave: handleTrySave,
    onToggleBookmark: handleToggleBookmark,
  });

  if (error?.message)
    return (
      <div className="min-h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <ErrorDisplay message={error?.message} file={file} />
        </div>
      </div>
    );
  if (isLoading) {
    return (
      <div className="min-h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-500">Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  const type = info.type;

  return (
    <div ref={rootRef} className="min-h-full flex flex-col">
      {editMode ? (
        <textarea
          ref={fileContentRef}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              handleTrySave(false);
            }
          }}
          disabled={saving}
          className="flex-1 p-6 text-sm text-gray-200 bg-gray-900 font-mono resize-none outline-none border-2 border-indigo-500/50"
          spellCheck={false}
        />
      ) : type === "image" ? (
        <ImageViewer file={file} />
      ) : type === "markdown" ? (
        <Suspense fallback={<MarkdownSkeleton />}>
          <MarkdownViewer
            mtime={info.mtime}
            file={file}
            content={info.content}
          />
        </Suspense>
      ) : type === "audio" || type === "video" ? (
        <MediaViewer file={file} type={type} />
      ) : type === "binary" ? (
        <BinaryFileViewer file={file} />
      ) : (
        <TextViewer content={info.content} />
      )}
      <UnsavedChangesModal blocker={blocker} />
      {info && (
        <Modal
          open={showConflictModal}
          onClose={() => setShowConflictModal(false)}
          title="File Modified"
        >
          <p>
            A version conflict was detected. The file has changed since you
            started editing.
          </p>
          <p className="mt-2">
            You can force save to overwrite their changes, or cancel and reload
            the file to see the latest version.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setShowConflictModal(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={handleSaveForce}
              disabled={saving}
            >
              Force Save
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
