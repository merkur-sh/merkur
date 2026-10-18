# Premium checklist

Each rule is testable on a screenshot, a recording or the code. Ordered by how often the
user feels a failure.

## Instant

1. Every press shows a visible response within 100 ms; the result lands within 400 ms or the
   control says it is working.
2. Toggles, renames, adds and deletes update optimistically and roll back in place with the
   error beside them.
3. No loading indicator appears for work under about 500 ms; once shown, it stays at least
   about 200 ms.
4. A press registers on pointer down with no ramp in (`active:duration-0`).
5. High-frequency surfaces (palette, list cursor, keyboard actions, tab switches) do not
   animate their appearance.

## Steady

6. No state change moves anything else: busy labels, errors and outcomes share one cell
   (`BusyLabel`, `MessageSlot`, `.swap-inline`); measure the boxes across states.
7. Changing or aligned figures use `tabular-nums`.
8. Skeletons match the final layout exactly.
9. Nothing flashes: no one-frame spinner, no blank frame between two surfaces, no
   double image in a cross-fade.
10. Lists keep their height while filtered or loading; rows leave in place and the rest slide
    in after.

## Caused

11. Nothing in the app moves without an input or a change of fact; no ambient loops.
12. Motion is transform and opacity only; no `transition: all`; no layout property animated.
13. Every animation can be reversed mid-flight and continues from where it is.
14. Reduced motion keeps every state change, minus the travel.
15. Every gesture cancels on release, leave, blur, Escape and unmount; the keyboard reaches
    every action.

## Quiet

16. Every grey is on the ramp; hover and press move one step.
17. Lines are low-alpha white and as few as the layout allows.
18. One accent per region; status is never colour alone.
19. One display moment per screen at most.
20. Copy is short, specific and in the house voice; placeholders end in `…`.

## Exact

21. Tracking tightens with size per the shortcut table; eyebrows open up.
22. Nested radii are concentric; radius matches the object's kind.
23. Touch targets are 44 px; pointer targets at least 24 px.
24. `:focus-visible` rings are visible, unclipped and 2 px or more.
25. Headings use `text-wrap: balance`; nothing truncates without a way to read it whole.
26. Inputs are 16 px or larger on touch.
27. The screen holds at phone width, at the 461 px frame breakpoint and at desktop, and with
    worst-case data (`break-ui`).
