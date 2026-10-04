import { useEffect, useRef, useState } from 'react';
import { Folder as FolderIcon, FolderInput } from 'lucide-react';
import type { FolderSettings } from '../../shared/types';

// The two folder dialogs. Settings is the one place a folder's name, description
// and auto-filing switch are edited, both when the folder is made and later from
// its context menu. The follow-up question only comes up when auto-filing has
// just been switched on: the server starts such a folder on new chats only, and
// "include existing chats" is the separate, explicit step that widens it.

export function FolderSettingsDialog(props: {
  mode: 'create' | 'edit';
  initial: FolderSettings;
  onSave: (settings: FolderSettings) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.initial.name);
  const [description, setDescription] = useState(props.initial.description);
  const [autoFile, setAutoFile] = useState(props.initial.autoFile);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const canSave = name.trim().length > 0;
  const save = () => {
    if (canSave) props.onSave({ name: name.trim(), description: description.trim(), autoFile });
  };

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={props.mode === 'create' ? 'New folder' : 'Folder settings'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onCancel();
      }}
    >
      <div className="mcp-approval-card folder-dialog">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <FolderIcon size={15} />
          </span>
          <strong>{props.mode === 'create' ? 'New folder' : 'Folder settings'}</strong>
        </div>
        <label className="folder-dialog-field">
          <span>Name</span>
          <input
            ref={nameRef}
            className="skill-approval-input"
            aria-label="Folder name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
          />
        </label>
        <label className="folder-dialog-field">
          <span>
            Description <em>optional</em>
          </span>
          <textarea
            className="ci-textarea"
            aria-label="Folder description"
            rows={3}
            placeholder="What belongs here, e.g. “Work on the Cloudfarms app: bugs, releases, customer questions”"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="set-check">
          <input type="checkbox" checked={autoFile} onChange={(e) => setAutoFile(e.target.checked)} />
          Move matching chats here automatically
        </label>
        <p className="muted folder-dialog-hint">
          Once a chat has sat untouched for a day, Stem moves it here if it fits the name and description.
          Chats you put somewhere yourself and private chats are never moved. Runs on the same model as
          subjects, under Models.
        </p>
        <div className="mcp-approval-actions">
          <button className="push" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="push default" onClick={save} disabled={!canSave}>
            {props.mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Asked right after auto-filing is switched on: new chats only, or the idle chats already at root too. */
export function IncludeOldChatsDialog(props: {
  folderName: string;
  onAnswer: (includeOld: boolean) => void;
}) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  useEffect(() => primaryRef.current?.focus(), []);

  return (
    <div
      className="mcp-approval-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Move existing chats too?"
      onKeyDown={(e) => {
        // Escape is the cautious answer: nothing old moves.
        if (e.key === 'Escape') props.onAnswer(false);
      }}
    >
      <div className="mcp-approval-card folder-dialog">
        <div className="mcp-approval-head">
          <span className="row-icon">
            <FolderInput size={15} />
          </span>
          <strong>Move existing chats too?</strong>
        </div>
        <p className="muted">
          From now on, new chats that fit “{props.folderName}” move there once they have been idle for a day.
        </p>
        <p className="muted">
          Stem can also look through the chats that are already outside any folder and have been idle for a
          day, and move the ones that fit. Each chat is looked at once, in the background. Chats you put
          somewhere yourself stay where they are.
        </p>
        <div className="mcp-approval-actions">
          <button className="push" onClick={() => props.onAnswer(true)}>
            Include existing chats
          </button>
          <button ref={primaryRef} className="push default" onClick={() => props.onAnswer(false)}>
            Only new chats
          </button>
        </div>
      </div>
    </div>
  );
}
