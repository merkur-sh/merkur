//! Admit only the complete, successful three-harness verification inventory.
use serde_json::Value;
use std::{collections::BTreeSet, fs};

const HARNESSES: [&str; 3] = [
    "proofs::custody_survives_provider_switch",
    "proofs::proof_channels_keep_exact_writer_custody",
    "proofs::unrelated_lane_keeps_credit",
];

fn tool_identity(report: &Value) -> Result<(), String> {
    if report["metadata"]["kani_version"] != "0.68.0"
        || report["tools"]["cbmc"] != "6.11.0 (cbmc-6.11.0)"
    {
        return Err("unexpected specialized verifier tool identity".into());
    }
    Ok(())
}

fn verify(report: &Value) -> Result<(), String> {
    let expected: BTreeSet<&str> = HARNESSES.into_iter().collect();
    let summary = &report["verification_results"]["summary"];
    if summary["total_harnesses"] != 3
        || summary["executed"] != 3
        || summary["successful"] != 3
        || summary["failed"] != 0
        || summary["status"] != "completed"
    {
        return Err("incomplete or unsuccessful verification summary".into());
    }
    let results = report["verification_results"]["results"]
        .as_array()
        .ok_or("missing verification results")?;
    let mut observed = BTreeSet::new();
    for result in results {
        let name = result["harness_id"]
            .as_str()
            .ok_or("missing harness identity")?;
        if !observed.insert(name) || !expected.contains(name) || result["status"] != "Success" {
            return Err(format!(
                "invalid, duplicated or unsuccessful harness: {name}"
            ));
        }
        let checks = result["checks"].as_array().ok_or("missing proof checks")?;
        if checks.is_empty()
            || checks
                .iter()
                .any(|check| !matches!(check["status"].as_str(), Some("Success" | "Unreachable")))
        {
            return Err(format!("unsuccessful or absent property checks: {name}"));
        }
    }
    if observed != expected {
        return Err("missing expected proof harness".into());
    }
    tool_identity(report)
}

fn verify_negative(report: &Value) -> Result<(), String> {
    tool_identity(report)?;
    let summary = &report["verification_results"]["summary"];
    if summary["total_harnesses"] != 1
        || summary["executed"] != 1
        || summary["successful"] != 0
        || summary["failed"] != 1
        || summary["status"] != "completed"
    {
        return Err("negative control did not complete exactly one failed proof".into());
    }
    let results = report["verification_results"]["results"]
        .as_array()
        .ok_or("missing negative results")?;
    if results.len() != 1
        || results[0]["harness_id"] != HARNESSES[0]
        || results[0]["status"] != "Failure"
    {
        return Err("unexpected negative-control harness/status".into());
    }
    let checks = results[0]["checks"]
        .as_array()
        .ok_or("missing negative-control properties")?;
    let expected = "assertion failed: writer_lane_blocked(blocked, conn, owned_channel)";
    let failed: Vec<&Value> = checks
        .iter()
        .filter(|check| check["status"] == "Failure")
        .collect();
    if checks.iter().any(|check| {
        !matches!(
            check["status"].as_str(),
            Some("Success" | "Unreachable" | "Failure")
        )
    }) || failed.is_empty()
        || failed
            .iter()
            .any(|check| check["category"] != "assertion" || check["description"] != expected)
    {
        return Err("negative control failed for a setup/unsupported/unrelated reason".into());
    }
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    assert!(
        matches!(args.len(), 2 | 3),
        "usage: check-kani RESULTS_JSON [negative]"
    );
    let report: Value = serde_json::from_slice(&fs::read(&args[1]).expect("read proof results"))
        .expect("parse proof results");
    if args.get(2).is_some_and(|arg| arg == "negative") {
        verify_negative(&report)
            .unwrap_or_else(|error| panic!("negative evidence rejected: {error}"));
        println!("Provider-specific custody mutation rejected by the intended proof assertion");
    } else {
        verify(&report).unwrap_or_else(|error| panic!("proof evidence rejected: {error}"));
        println!("3 bounded ownership harnesses verified with Kani 0.68.0 and CBMC 6.11.0");
    }
}

#[cfg(test)]
mod tests {
    use super::{HARNESSES, verify, verify_negative};
    use serde_json::json;

    fn report() -> serde_json::Value {
        json!({
            "metadata": {"kani_version": "0.68.0"},
            "tools": {"cbmc": "6.11.0 (cbmc-6.11.0)"},
            "verification_results": {
                "summary": {"total_harnesses": 3, "executed": 3, "successful": 3, "failed": 0, "status": "completed"},
                "results": HARNESSES.map(|name| json!({"harness_id": name, "status": "Success", "checks": [{"status": "Success"}]})),
            },
        })
    }

    #[test]
    fn exact_complete_inventory_is_required() {
        let good = report();
        assert!(verify(&good).is_ok());
        let mut missing = report();
        missing["verification_results"]["results"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert!(verify(&missing).is_err());
        let mut duplicate = report();
        duplicate["verification_results"]["results"][1]["harness_id"] = json!(HARNESSES[0]);
        assert!(verify(&duplicate).is_err());
        let mut failed = report();
        failed["verification_results"]["results"][0]["checks"][0]["status"] = json!("Failure");
        assert!(verify(&failed).is_err());
        let mut incomplete = report();
        incomplete["verification_results"]["summary"]["executed"] = json!(2);
        assert!(verify(&incomplete).is_err());
    }

    #[test]
    fn negative_setup_and_unrelated_failures_are_rejected() {
        let mut intended = report();
        intended["verification_results"]["summary"] = json!({
            "total_harnesses": 1, "executed": 1, "successful": 0,
            "failed": 1, "status": "completed",
        });
        intended["verification_results"]["results"] = json!([{
            "harness_id": HARNESSES[0], "status": "Failure", "checks": [{
                "status": "Failure", "category": "assertion",
                "description": "assertion failed: writer_lane_blocked(blocked, conn, owned_channel)",
            }],
        }]);
        assert!(verify_negative(&intended).is_ok());
        // An intended counterexample cannot mask a partially failed verifier.
        for status in ["Unknown", "Error", "Undetermined", "Unsupported", "Pending"] {
            let mut mixed = intended.clone();
            mixed["verification_results"]["results"][0]["checks"]
                .as_array_mut()
                .unwrap()
                .push(json!({"status": status, "category": "unsupported_construct"}));
            assert!(verify_negative(&mixed).is_err(), "{status}");
        }
        for (field, value) in [("metadata", "kani_version"), ("tools", "cbmc")] {
            let mut other_engine = intended.clone();
            other_engine[field][value] = json!("unqualified tool");
            assert!(verify_negative(&other_engine).is_err());
        }
        let mut complete = intended.clone();
        complete["verification_results"]["results"][0]["checks"]
            .as_array_mut()
            .unwrap()
            .extend([
                json!({"status": "Success"}),
                json!({"status": "Unreachable"}),
            ]);
        assert!(verify_negative(&complete).is_ok());

        assert!(verify_negative(&json!({})).is_err());
        let mut unrelated = intended.clone();
        unrelated["verification_results"]["results"][0]["checks"][0]["description"] =
            json!("another invariant");
        assert!(verify_negative(&unrelated).is_err());
        let mut setup = intended;
        setup["verification_results"]["results"][0]["checks"][0]["category"] =
            json!("unsupported_construct");
        assert!(verify_negative(&setup).is_err());
    }
}
