# Which generation prompt should Mystery Rush ship?

Reproduce with `npm run eval:prompts -- 20`. Raw numbers land in
[`evaluation-results.json`](evaluation-results.json).

## 1. Goal

The riskiest assumption in this product is that **AI can reliably write five clues that reveal a
subject gradually and leave exactly one defensible answer.** If it cannot, the host ends up editing
generated text, which is slower than writing it themselves and the whole feature is pointless.

So: does a long, structured prompt actually produce better mysteries than simply asking for some,
and by enough to justify its complexity?

## 2. Test dataset

40 mysteries generated live by `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — 20 per prompt, in
batches of 5, rotating through five categories (`landmark`, `movie`, `food`, `animal`, `space`) at
`medium` difficulty. Both variants got the same categories, the same batch size and the same
temperature (0.8). Total runtime 3.0 minutes.

Not a fixed corpus: the point is what the model does on a cold request, which is what a host gets.

## 3. Prompt A — basic

Roughly:

> Write N quiz mystery questions for a party game, in the categories X, at medium difficulty. Each
> mystery needs a title, an answer, 5 answer options, and 5 clues about the answer. Reply with JSON
> only.

Source: `buildBasicGenerationPrompt` in [`src/worker/llm.ts`](../src/worker/llm.ts).

## 4. Prompt B — structured (production)

Same request, but it explains the game first — one clue at a time, earlier guesses worth more —
and then states the rules that follow from it: clue 1 vague through clue 5 obvious, every clue
adding new information, never name the answer before the last clue, never name another option,
exactly one defensible answer, plausible distractors, unique options, factual caution, no repeated
subjects, spread across the chosen categories, first person.

Source: `buildGenerationPrompt` in the same file.

**Both variants were given the identical JSON schema**, including the `enum` that pins the category.
That matters for reading the results below.

## 5. Criteria

Every mystery goes through the real deterministic validator
([`mystery-validation.ts`](../src/worker/mystery-validation.ts)) and then, if it passes, the real
evaluator prompt. No separate rubric was invented for this exercise — comparing against a different
judge would say nothing about production.

Measured: valid / invalid, category violations, clue count, answer missing from options, duplicate
options, duplicate answers, answer revealed before clue 5, empty or too-short clues, evaluator
score, evaluator ambiguity.

## 6. Results

| | Prompt A | Prompt B |
|---|---|---|
| **Valid (playable)** | **15 / 20** | **19 / 20** |
| Duplicate answers | 4 | 1 |
| Empty or too-short clues | 1 | 0 |
| Category violations | 0 | 0 |
| Wrong clue count | 0 | 0 |
| Answer missing from options | 0 | 0 |
| Duplicate options | 0 | 0 |
| Answer revealed before clue 5 | 0 | 0 |
| Evaluator average score | 96 | 95 |
| Evaluator average ambiguity | 0.053 | 0.042 |
| Evaluator approved | 15 / 15 | 19 / 19 |

**Prompt B produced 27% more usable mysteries per run** (19 vs 15), and every point of that
difference is duplicate answers and one unusably short clue.

Two results are worth stating plainly because they cut against the prompt:

- **The schema fixed categories, not the prompt.** The first live call this project ever made
  returned `"type": "multiple choice"`. Once the schema constrained the field to an `enum`, both
  prompts scored zero category violations. Prompt B's paragraph about categories is not doing that
  work.
- **The evaluator does not discriminate.** 96 vs 95, with ambiguity near zero for both, is not a
  signal. A model scoring output from the same model family, mostly on subjects it knows well,
  rates nearly everything highly.

## 7. Example failures

The numbers understate the difference. The clue writing is where it actually shows:

**Prompt A**, *The Shawshank Redemption*:

```
clue 1: Released in 1994
clue 2: Stars Tim Robbins and Morgan Freeman
```

Structurally valid — five clues, answer among the options — and useless as a game. Clue 2 hands the
film to anyone who knows it, on a clue still worth 400 points, and the clues are flat facts rather
than a subject speaking. The validator has no rule for "clue 2 names the cast", and the evaluator
scored it well anyway.

**Prompt B**, same subject:

```
clue 1: I'm a movie that was initially a box office disappointment.
clue 2: I've become a classic of my genre, and I'm often cited as one of the greatest films of all time.
```

Vague first, narrowing second, in voice, no giveaway.

**Prompt A**'s actual failure mode was repetition: asked for five food mysteries it returned Sushi
and Tacos twice within one pool, and Shawshank and Silence of the Lambs twice among the films. It
has no instruction not to.

**Prompt B still fails.** One duplicate answer survived, and this slipped through as a warning:

```
answer: Black Hole
clue 3 names another option, "Star"
```

The host sees that warning and decides. This is the case for keeping a human in the loop rather
than auto-approving on a high score.

## 8. Decision

**Prompt B ships.** Not because of the evaluator scores, which say nothing, but because it yields
27% more playable mysteries per request and writes visibly better clues. For the outcome metric —
ten playable mysteries in under five minutes — that is the difference between one generation pass
and two.

Three design choices this settles, each of which was provisional before the run:

1. **The category enum stays in the JSON schema.** It was added as a guess after one bad call; this
   shows it is the thing actually enforcing categories, so it is not redundant with the prompt and
   should not be dropped.
2. **The avoid-list of existing answers stays.** Duplication is the one failure the prompt does not
   fix on its own, so passing answers the event already has is load-bearing rather than belt-and-braces.
3. **The evaluator score is not a gate on its own.** This was the open question going in. A judge
   that rates "Stars Tim Robbins and Morgan Freeman" at 96 cannot be trusted to decide what a room
   sees.

### Postscript: the approve button went away anyway

The host console no longer has a review step — questions are written in the lobby and go straight
into play. That is a product decision, and it does not make the finding above less true, so the
automatic bar in `mystery-pool.ts` is built around it rather than in spite of it:

- **The deterministic rules carry the veto.** A validation *warning* is disqualifying under
  auto-accept, even though a host reading the candidate would have been allowed to weigh it. The
  rules found the clue-craft failures in §7; the evaluator did not.
- **The evaluator can only lower the verdict, never raise it.** It is an AND with the rules
  (`approved`, `score >= 75`, `ambiguity <= 0.3`), so a generous score cannot rescue anything.
- **An unjudged mystery fails.** If the evaluation call could not be made, nobody has read the
  question at all, and a built-in one is a better answer than an unread one.
- **Rejection is cheap.** A candidate that misses the bar is replaced within the same request, and a
  shortfall falls back to the 25 hand-written mysteries. The cost of the bar being strict is a
  built-in question; the cost of it being lax is on the projector.

## 9. Limitations

- **n = 20 per prompt, one run, one model.** Enough to see a 4-mystery gap in validity; not enough
  to resolve the 1-point score difference, which is noise.
- **The judge is the same model family as the generator**, so this measures self-consistency more
  than quality. The clue-craft gap in §7 was found by reading the output, not by the evaluator.
- **No human ratings.** The honest test is whether a room finds these fun, which has not happened
  yet.
- **Clue progression is not measured directly.** "Does clue 3 reveal more than clue 2" has no
  metric here; it is the thing the evaluator is supposed to catch and demonstrably catches weakly.
- The harness calls Workers AI over REST rather than through the Worker, because the production
  endpoint deliberately does not let a caller choose a prompt. Prompts, schema, model and validator
  are imported from the shipped source; only the transport differs.
