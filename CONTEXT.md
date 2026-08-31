# Omarchy Agents

Omarchy Agents is a local-first evidence console for understanding personal AI-agent activity and deciding what to improve without surrendering control to automation.

## Language

**Finding**:
An observed pattern in indexed agent activity that is supported by one or more evidence citations.
_Avoid_: Insight, anomaly

**Suggestion**:
A specific change proposed by the analyst in response to a finding. A suggestion remains advisory until the user acts on it.
_Avoid_: Recommendation, instruction

**Experiment**:
A user-authorized attempt to evaluate one suggestion against a confirmed metric and target.
_Avoid_: Automation, task, test

**Cohort**:
An explicitly selected set of sessions used as either the baseline or trial side of an experiment.
_Avoid_: Segment, inferred group

**Review**:
An immutable assessment of an experiment at a point in time, including its calculated evidence, the user's note, and the chosen outcome.
_Avoid_: Report, verdict

**Outcome**:
The user's decision to adopt the change, extend the trial, or record no improvement.
_Avoid_: Automated decision

**Evidence citation**:
A stable reference to an indexed session or an exact event within that session that supports a finding or experiment claim.
_Avoid_: Source link, proof
