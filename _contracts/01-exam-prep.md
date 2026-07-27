# Contract: Exam Prep (v2 — MCQ + long-form)
**Status:** Draft
**Week:** Week 2
**Daily Limit:** Unlimited (still zero AI at query time)
**Estimated Cost (350 students):** ₹0 at query time (model answers pre-generated OFFLINE at authoring time)

---

## v2 Changes vs Original
- Questions are `mcq` OR `long_form` (written answers)
- Long-form: student writes the answer → receives the pre-written **comparing answer sheet** (`model_answer`) next to their own text
- Self-generated papers (`content_source='generated'`) MUST have a model_answer authored offline before going live
- **Analytics**: per-student score trends from the new `exam_attempts` table — pure SQL, no AI

## Definition of Done
Student completes a mixed MCQ/long-form paper, sees auto-scored MCQs with explanations and model answer sheets for written questions, and can view score trends — with zero AI calls at query time.

## API Endpoints
| Method | Path |
|---|---|
| GET  | /api/exam/questions?exam_type=&format=mcq|long_form|mixed |
| POST | /api/exam/submit — full attempt, returns results + comparing answer sheet |
| GET  | /api/exam/analytics |

## DB
exam_content (+question_format, model_answer, content_source; options/correct_answer nullable), exam_attempts (NEW, has college_id + RLS), feature_usage

## Pre-Deploy Checklist
- [ ] Normal / [ ] Stupid (empty long-form answer, view-source: correct/model answers must NOT be in the questions payload)
- [ ] Access — read another student's attempt → 403
- [ ] Limit — n/a  · [ ] Cost — confirm zero AI calls in ai_usage_log
