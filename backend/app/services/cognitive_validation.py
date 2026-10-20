"""Versioned engineering evidence checks, independent of clinical comparability."""
from collections import Counter
from copy import deepcopy
from datetime import datetime,timezone
import math
from statistics import median

from fastapi import HTTPException
from backend.app.services.cognitive_contract import canonical_digest

RULE_VERSION = "w04-engineering-quality-v1"
COLORS = {"red","green","blue","yellow"}


def require(condition,message):
    if not condition:
        raise HTTPException(422,message)


def number(value,*,maximum=None):
    require(type(value) in {int,float} and math.isfinite(value) and value >= 0,"Actual timing/counts require finite nonnegative numbers, never booleans.")
    require(maximum is None or value <= maximum,"An actual response exceeds the frozen response window.")
    return value


def integer(value,minimum=0,maximum=None):
    require(type(value) is int and value >= minimum and (maximum is None or value <= maximum),"Actual stimulus/count identifiers must be bounded integers.")
    return value


def choice(value,allowed):
    return isinstance(value,str) and value in allowed


def check(row,expected):
    for key,value in expected.items():
        require(key in row and type(row[key]) is type(value) and row[key] == value,"Actual stimulus/response contradicts the derived "+key+".")


def rounded(value):
    return math.floor(value+0.5)


def percent(correct,total):
    return rounded(100*correct/total) if total else 0


def average(values):
    return rounded(sum(values)/len(values)) if values else 0


def middle(values):
    return rounded(median(values)) if values else 0


def timed(row,key,missing=False,maximum=None):
    value = row.get(key)
    if missing:
        require(value is None,"An unanswered trial cannot invent a response latency.")
        return None
    return number(value,maximum=maximum)


def sequence(stage,count):
    return [str(index) for index in range(1,count+1)] if stage == "A" else [label for index in range(1,count+1) for label in (str(index),chr(64+index))]


def trial_summary(task,trials,config,*,practice=False,stages=None):
    require(isinstance(trials,list) and trials and len(trials) <= 10000,"Actual individual trials are required.")
    require(all(isinstance(row,dict) for row in trials),"Each actual trial must be an object.")
    expected_count = config.get("practiceTrials") if practice else config.get("formalTrials")
    if task in {"reaction","stroop","flanker","nback"}:
        require(len(trials) == expected_count,"Actual trial count does not match the frozen task configuration.")
        for index,row in enumerate(trials):
            for key in ("trial","id"):
                if key in row:
                    require(type(row[key]) is int and row[key] == index+1,"Trial order/identifier is inconsistent.")
    if task == "reaction":
        for row in trials:
            require(choice(row.get("type"),{"go","nogo"}) and choice(row.get("action"),{"tap","timeout","false_start"}),"Unknown Go/No-Go stimulus or action.")
            stimulus,action = row["type"],row["action"]
            correct = action != "false_start" and (stimulus == "go" and action == "tap" or stimulus == "nogo" and action == "timeout")
            error = "false_start" if action == "false_start" else "omission" if stimulus == "go" and action == "timeout" else "commission" if stimulus == "nogo" and action == "tap" else None
            check(row,{"correct":correct,"errorType":error})
            timed(row,"reactionTimeMs",missing=not (stimulus == "go" and action == "tap"),maximum=config["responseWindowMs"])
        require(sum(row["type"] == "nogo" for row in trials) == len(trials)//5,"Frozen Go/No-Go ratio does not match actual stimuli.")
        gos = [row for row in trials if row["type"] == "go"]
        nogos = [row for row in trials if row["type"] == "nogo"]
        times = [row["reactionTimeMs"] for row in gos if row["correct"]]
        return {"total_trials":len(trials),"correct_trials":sum(row["correct"] for row in trials),"accuracy":percent(sum(row["correct"] for row in trials),len(trials)),"go_accuracy":percent(sum(row["correct"] for row in gos),len(gos)),"nogo_accuracy":percent(sum(row["correct"] for row in nogos),len(nogos)),"average_reaction_time_ms":average(times),"fastest_reaction_time_ms":min(times) if times else 0,"commission_errors":sum(row["errorType"] == "commission" for row in trials),"omission_errors":sum(row["errorType"] == "omission" for row in trials),"false_starts":sum(row["errorType"] == "false_start" for row in trials)}
    if task == "stroop":
        for row in trials:
            require(choice(row.get("wordKey"),COLORS) and choice(row.get("colorKey"),COLORS) and choice(row.get("selectedKey"),COLORS|{""}),"Unknown actual Stroop color/response.")
            omission = row["selectedKey"] == ""
            check(row,{"congruent":row["wordKey"] == row["colorKey"],"correct":not omission and row["selectedKey"] == row["colorKey"]})
            if omission: check(row,{"outcome":"omission"})
            timed(row,"reactionTimeMs",missing=omission,maximum=config["responseWindowMs"])
        require(sum(row["congruent"] for row in trials) == rounded(len(trials)*config["congruentRatio"]),"Actual congruency ratio differs from the frozen Stroop configuration.")
        correct = [row for row in trials if row["correct"]]
        times = [row["reactionTimeMs"] for row in trials if row["reactionTimeMs"] is not None]
        congruent = [row for row in trials if row["congruent"]]
        incongruent = [row for row in trials if not row["congruent"]]
        congruent_median = middle([row["reactionTimeMs"] for row in congruent if row["correct"]])
        incongruent_median = middle([row["reactionTimeMs"] for row in incongruent if row["correct"]])
        return {"total_trials":len(trials),"correct":len(correct),"wrong":len(trials)-len(correct),"omissions":sum(row.get("outcome") == "omission" for row in trials),"accuracy":percent(len(correct),len(trials)),"average_reaction_time_ms":average(times),"median_reaction_time_ms":middle([row["reactionTimeMs"] for row in correct]),"fastest_reaction_time_ms":min(times) if times else 0,"congruent_accuracy":percent(sum(row["correct"] for row in congruent),len(congruent)),"incongruent_accuracy":percent(sum(row["correct"] for row in incongruent),len(incongruent)),"congruent_median_reaction_time_ms":congruent_median,"incongruent_median_reaction_time_ms":incongruent_median,"interference_effect_ms":incongruent_median-congruent_median}
    if task == "flanker":
        for row in trials:
            require(choice(row.get("condition"),{"congruent","incongruent","neutral"}) and choice(row.get("target"),{"left","right"}) and choice(row.get("answer"),{"left","right",""}),"Unknown actual Flanker stimulus or response.")
            omission = row["answer"] == ""
            correct = not omission and row["answer"] == row["target"]
            check(row,{"correct":correct,"outcome":"omission" if omission else "correct" if correct else "wrong"})
            timed(row,"responseTimeMs",missing=omission,maximum=config["responseWindowMs"])
        if not practice:
            require(set(Counter(row["condition"] for row in trials).values()) == {len(trials)//3},"Actual Flanker conditions do not match the frozen balanced protocol.")
            require(sum(row["target"] == "left" for row in trials) == len(trials)//2,"Actual Flanker targets are unbalanced.")
        conditions = {}
        for condition in ("congruent","incongruent","neutral"):
            rows = [row for row in trials if row["condition"] == condition]
            conditions[condition] = {"total":len(rows),"accuracy":percent(sum(row["correct"] for row in rows),len(rows)),"median_reaction_time_ms":middle([row["responseTimeMs"] for row in rows if row["correct"]])}
        return {"total_trials":len(trials),"correct_trials":sum(row["correct"] for row in trials),"accuracy":percent(sum(row["correct"] for row in trials),len(trials)),"average_reaction_time_ms":average([row["responseTimeMs"] for row in trials if row["correct"]]),"conflict_effect_ms":conditions["incongruent"]["median_reaction_time_ms"]-conditions["congruent"]["median_reaction_time_ms"],"omissions":sum(row["outcome"] == "omission" for row in trials),"condition_metrics":conditions}
    if task == "nback":
        for index,row in enumerate(trials):
            integer(row.get("position"),0,8)
            target = index >= 2 and row["position"] == trials[index-2]["position"]
            check(row,{"isTarget":target,"scored":index >= 2})
            if index < 2:
                check(row,{"answeredMatch":None,"outcome":"warmup","correct":None})
                timed(row,"responseTimeMs")
                continue
            require(row.get("answeredMatch") is None or type(row["answeredMatch"]) is bool,"Actual N-back match response must be boolean or an omission.")
            answer = row["answeredMatch"]
            outcome = "omission" if answer is None else "hit" if target and answer else "miss" if target else "false_alarm" if answer else "correct_rejection"
            check(row,{"outcome":outcome,"correct":outcome in {"hit","correct_rejection"}})
            # This project's N-back advances through explicit actions and has
            # no automatic timeout; config.responseWindowMs is not enforced as
            # a deadline contrary to the actual instruction/executor contract.
            timed(row,"responseTimeMs",missing=answer is None)
        require(sum(row["isTarget"] for row in trials) == rounded((len(trials)-2)/3),"Actual 2-back target ratio differs from the frozen generator.")
        scored = trials[2:]
        counts = Counter(row["outcome"] for row in scored)
        hits,misses,false_alarms,rejections = (counts[key] for key in ("hit","miss","false_alarm","correct_rejection"))
        hit_rate = (hits+0.5)/(hits+misses+1)
        alarm_rate = (false_alarms+0.5)/(false_alarms+rejections+1)
        d_prime = float(f"{(math.log(hit_rate/(1-hit_rate))-math.log(alarm_rate/(1-alarm_rate)))/1.7:.2f}")
        return {"total_trials":len(scored),"correct_trials":hits+rejections,"hits":hits,"misses":misses,"false_alarms":false_alarms,"correct_rejections":rejections,"omissions":counts["omission"],"accuracy":percent(hits+rejections,len(scored)),"average_reaction_time_ms":average([row["responseTimeMs"] for row in scored if row["correct"]]),"d_prime":d_prime}
    if task == "digit":
        for row in trials:
            require(choice(row.get("direction"),{"forward","backward"}),"Unknown actual digit direction.")
            span = integer(row.get("span"),config["minSpan"],config["maxSpan"])
            integer(row.get("attempt"),1,config["trialsPerSpan"])
            stimulus,answer = row.get("sequence"),row.get("answer")
            require(isinstance(stimulus,list) and len(stimulus) == span and isinstance(answer,list) and len(answer) <= 100,"Actual digit sequence and actual answer are required.")
            for digit in stimulus+answer: integer(digit,0,9)
            require(all(stimulus[index] != stimulus[index-1] for index in range(1,len(stimulus))),"Digit generator prohibits adjacent duplicate stimuli.")
            expected = stimulus[::-1] if row["direction"] == "backward" else stimulus
            correct_digits = sum(index < len(answer) and answer[index] == digit for index,digit in enumerate(expected))
            check(row,{"expected":expected,"correctDigits":correct_digits,"correct":answer == expected})
        require([row["direction"] for row in trials] == sorted([row["direction"] for row in trials],key=lambda direction:0 if direction == "forward" else 1),"Actual digit directions must preserve the execution order.")
        for direction in ("forward","backward"):
            rows = [row for row in trials if row["direction"] == direction]
            if practice:
                require(len(rows) == 1 and rows[0]["span"] == config["minSpan"] and rows[0]["attempt"] == 1,"Digit practice requires one actual minimal-span trial in each direction.")
                continue
            offset = 0
            for span in range(config["minSpan"],config["maxSpan"]+1):
                group = rows[offset:offset+config["trialsPerSpan"]]
                require(len(group) == config["trialsPerSpan"] and all(row["span"] == span and row["attempt"] == index+1 for index,row in enumerate(group)),"Actual digit span progression is incomplete or reordered.")
                offset += len(group)
                if not any(row["correct"] for row in group):
                    break
            require(offset == len(rows),"Actual digit trials cannot continue after the frozen stop rule.")
        correct = [row for row in trials if row["correct"]]
        span = lambda direction:max([row["span"] for row in correct if row["direction"] == direction],default=0)
        return {"total_trials":len(trials),"correct_trials":len(correct),"accuracy":percent(len(correct),len(trials)),"forward_max_span":span("forward"),"backward_max_span":span("backward"),"correct_digits":sum(row["correctDigits"] for row in trials),"total_digits":sum(row["span"] for row in trials)}
    if task == "trail":
        expected_stages = ("A",) if practice else ("A","B")
        if not practice:
            require(isinstance(stages,list) and len(stages) == len(expected_stages) and all(isinstance(row,dict) for row in stages),"Actual trail stage summaries must be objects in a complete stage list.")
        require(all(row.get("stage") in expected_stages for row in trials),"Unknown actual trail stage.")
        actual = []
        for stage in expected_stages:
            rows = [row for row in trials if row["stage"] == stage]
            order = sequence(stage,config["practiceNodes"] if practice else config["partANodes"] if stage == "A" else config["partBPairs"])
            index,errors,last_time = 0,0,0
            for row in rows:
                require(index < len(order) and row.get("label") in order,"Actual trail taps cannot overrun or invent a node.")
                correct = row["label"] == order[index]
                check(row,{"expected":order[index],"correct":correct})
                current = number(row.get("elapsedMs"))
                require(current >= last_time,"Actual trail tap timing is not monotonic.")
                last_time = current
                if correct: index += 1
                else: errors += 1
            require(index == len(order),"Actual trail stage is incomplete.")
            if practice:
                elapsed = last_time
            else:
                supplied = next((row for row in stages or [] if row.get("stage") == stage),None)
                require(supplied is not None,"Actual trail stage end timing is required.")
                check(supplied,{"nodeCount":len(order),"errors":errors,"completed":True})
                elapsed = number(supplied.get("elapsedMs"))
                require(elapsed >= last_time,"Trail stage completion precedes its last actual tap.")
            actual.append({"stage":stage,"elapsedMs":elapsed,"errors":errors,"nodeCount":len(order),"completed":True})
        require([row["stage"] for row in trials] == sorted([row["stage"] for row in trials],key=lambda value:expected_stages.index(value)),"Trail stage order is inconsistent.")
        nodes = sum(stage["nodeCount"] for stage in actual)
        errors = sum(stage["errors"] for stage in actual)
        return {"elapsed_ms":sum(stage["elapsedMs"] for stage in actual),"errors":errors,"accuracy":percent(nodes,nodes+errors),"completed":True,"stages":actual}
    raise HTTPException(422,"Unsupported frozen cognitive task.")


def validate_cognitive_evidence(content,attempt,definition):
    source = content["result_json"]
    config = attempt.config_snapshot
    expected_source = {"miniprogram":"miniprogram", "web":"patient_web"}.get(attempt.execution_metadata.get("device",{}).get("platform"))
    require(expected_source is not None and content["test_type"] == definition["instrument"] and source.get("source") == expected_source and source.get("protocol_id") == attempt.protocol_id and type(source.get("protocol_schema_version")) is int and source["protocol_schema_version"] == attempt.protocol_schema_version and source.get("schema_version") == 2 and source.get("age_group") == attempt.age_group and source.get("test_run_id") == attempt.run_id,"Actual cognitive source/protocol/schema/age/run must match the original server attempt.")
    canonical_digest(content)
    require(isinstance(source.get("finished_at"),str),"Actual completion requires a timezone-aware valid timestamp.")
    try:
        finished = datetime.fromisoformat(source["finished_at"].replace("Z","+00:00"))
        started = attempt.created_at if attempt.created_at.tzinfo else attempt.created_at.replace(tzinfo=timezone.utc)
        require(finished.tzinfo is not None and finished >= started,"Actual completion time cannot precede its server attempt.")
    except (KeyError,TypeError,ValueError) as exc:
        raise HTTPException(422,"Actual completion requires a timezone-aware valid timestamp.") from exc
    trials = source.get("trials")
    raw = source.get("raw_result")
    require(isinstance(raw,dict),"Actual client raw summary must be an object.")
    computed = trial_summary(definition["instrument"],trials,config,stages=raw.get("stages"))
    require(type(source.get("actual_trials")) is int and source["actual_trials"] == len(trials),"Declared actual_trials must match individual evidence, including N-back warmup stimuli.")
    for key,value in computed.items():
        require(key in raw and canonical_digest(raw[key]) == canonical_digest(value),"Client summary contradicts server calculation of "+key+".")
    metadata = content["execution_metadata"]
    start = attempt.execution_metadata
    for key in ("device","input","timing","assistance"):
        require(metadata[key] == start[key],"Formal cognitive execution must remain on the original actual device/input/timing/assistance context.")
    reasons = []
    device = metadata["device"]
    if device.get("device_type") in {"unknown","unspecified"} or not device.get("viewport_width") or not device.get("viewport_height"):
        reasons.append("unknown_device")
    if metadata["input"]["method"] == "unknown": reasons.append("unknown_input")
    if metadata["timing"]["clock_source"] not in {"Date.now","performance.now","wx.performance.now"} or metadata["timing"]["unit"] != "ms": reasons.append("unknown_clock")
    if metadata["interrupted_count"]:
        reasons.append("execution_interrupted")
    if metadata["assistance"]["provided"]:
        reasons.append("assistance_requires_review")
    groups = metadata["practice_records"]
    practice = metadata["practice"]
    require(practice["exposure_count"] >= start["practice"]["exposure_count"],"Actual exposure counts cannot decrease within an attempt.")
    if not groups:
        reasons.append("practice_evidence_incomplete")
    else:
        require(len(groups) == practice["attempts"] and 1 <= len(groups) <= config["maxPracticeAttempts"],"Actual practice count must match its immutable records.")
        scores = []
        for index,group in enumerate(groups):
            require(group["attempt"] == index+1,"Actual practice attempts must be consecutive.")
            scores.append(trial_summary(definition["instrument"],group["trials"],config,practice=True)["accuracy"])
        if not practice["completed"] or scores[-1] < config["practicePassPercent"]:
            reasons.append("practice_not_passed")
        require(all(score < config["practicePassPercent"] for score in scores[:-1]),"Extra practice attempts cannot be hidden after a successful practice.")
    omissions = computed.get("omissions",computed.get("omission_errors",0))
    if omissions > max(2,computed.get("total_trials",len(trials))*0.15): reasons.append("high_omissions")
    if computed.get("false_starts",0) > len(trials)*0.15: reasons.append("high_false_starts")
    if definition["instrument"] in {"stroop","nback"} and computed["accuracy"] < 40: reasons.append("low_accuracy")
    if definition["instrument"] == "digit" and not computed["correct_trials"]: reasons.append("no_correct_trials")
    if any(row.get("correct") is True and row.get("reactionTimeMs",row.get("responseTimeMs",1)) == 0 for row in trials): reasons.append("nonpositive_response_time")
    comparison = ["device_equivalence_not_verified","professional_template_admission_not_approved"]
    # A client declaration is never a device calibration certificate.
    comparison.append("timing_calibration_not_verified")
    result = deepcopy(source)
    result["raw_result"] = computed
    result["quality"] = {"status":"limited" if reasons else "valid","valid":not reasons,"reasons":reasons,"rule_version":RULE_VERSION,"interrupted_count":metadata["interrupted_count"],"practice_attempts":len(groups)}
    result["comparability"] = {"status":"not_verified","reasons":comparison}
    result["demonstration_only"] = True
    return result,"limited" if reasons else "valid",reasons,comparison
