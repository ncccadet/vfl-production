/**
 * draftingLab.service.js
 * All Drafting Lab API calls. Pages import from here — never call api directly.
 * Contract: _contracts/04-drafting-lab.md
 */
import api from './api';

export const getTypes = () => api.get('/api/drafting-lab/types');
export const generateCase = (draftType) => api.post('/api/drafting-lab/case-study', { draftType });
export const getResult = (docId) => api.get(`/api/drafting-lab/case-study/result/${docId}`);
export const getHistory = () => api.get('/api/drafting-lab/history');

// Assemble a template by substituting {{blank_id}} tokens with the student's answers.
// Empty blanks render as an underline so the layout still reads like a form draft.
export const assembleDraft = (template, answers) =>
  String(template || '').replace(/\{\{(\w+)\}\}/g, (_, id) => {
    const v = (answers[id] || '').trim();
    return v || '________';
  });

// Client-side download of the completed draft as a Word-openable .doc (no deps).
export const downloadDoc = (filename, heading, bodyText) => {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8">` +
    `<style>body{font-family:Georgia,'Times New Roman',serif;font-size:12pt;white-space:pre-wrap;line-height:1.5;} h2{text-align:center;}</style>` +
    `</head><body><h2>${esc(heading)}</h2><div>${esc(bodyText)}</div></body></html>`;
  const blob = new Blob(['﻿', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.doc') ? filename : `${filename}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
