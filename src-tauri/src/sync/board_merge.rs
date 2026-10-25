//! Three-way merge of `.bmnotes/board.json` so moving different cards never conflicts.
use serde_json::{Map, Value};

pub fn merge_board(base: Option<&str>, ours: Option<&str>, theirs: Option<&str>) -> Option<String> {
    let parse = |s: Option<&str>| s.and_then(|t| serde_json::from_str::<Value>(t).ok());
    let (o, t) = (parse(ours)?, parse(theirs)?);
    let b = parse(base).unwrap_or(Value::Null);
    serde_json::to_string_pretty(&merge3(&b, &o, &t)).ok()
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str)
}

fn by_id(a: &[Value]) -> Option<Map<String, Value>> {
    let mut m = Map::new();
    for v in a {
        m.insert(id_of(v)?.to_string(), v.clone());
    }
    Some(m)
}

pub fn merge3(base: &Value, ours: &Value, theirs: &Value) -> Value {
    if ours == theirs || theirs == base {
        return ours.clone();
    }
    if ours == base {
        return theirs.clone();
    }
    match (ours, theirs) {
        (Value::Object(o), Value::Object(t)) => Value::Object(merge_maps(base.as_object(), o, t)),
        (Value::Array(o), Value::Array(t)) => {
            let b = base.as_array().and_then(|a| by_id(a)).unwrap_or_default();
            match (by_id(o), by_id(t)) {
                (Some(om), Some(tm)) => {
                    let merged = merge_maps(Some(&b), &om, &tm);
                    let mut order: Vec<&str> = o.iter().filter_map(id_of).collect();
                    let extra: Vec<&str> = t.iter().filter_map(id_of).filter(|i| !order.contains(i)).collect();
                    order.extend(extra);
                    Value::Array(order.iter().filter_map(|i| merged.get(*i).cloned()).collect())
                }
                _ => ours.clone(),
            }
        }
        // Scalars changed on both sides (e.g. the viewport): this machine wins.
        _ => ours.clone(),
    }
}

fn merge_maps(base: Option<&Map<String, Value>>, ours: &Map<String, Value>, theirs: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let keys: Vec<&String> = ours.keys().chain(theirs.keys().filter(|k| !ours.contains_key(*k))).collect();
    for k in keys {
        let b = base.and_then(|m| m.get(k));
        match (ours.get(k), theirs.get(k)) {
            (Some(o), Some(t)) => {
                out.insert(k.clone(), merge3(b.unwrap_or(&Value::Null), o, t));
            }
            // Removed on one side: honour the removal unless the other side changed it.
            (Some(o), None) => {
                if b.is_none() || b != Some(o) {
                    out.insert(k.clone(), o.clone());
                }
            }
            (None, Some(t)) => {
                if b.is_none() || b != Some(t) {
                    out.insert(k.clone(), t.clone());
                }
            }
            (None, None) => {}
        }
    }
    out
}
