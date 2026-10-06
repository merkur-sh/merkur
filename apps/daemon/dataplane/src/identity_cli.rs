use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use merkur_identity_seal::{self as identity_seal, Backend, IdentitySealWire, SealError};
use std::io::{Read, Write};
use zeroize::Zeroizing;

pub fn run(args: &[String]) -> i32 {
    match execute(
        args,
        &mut std::io::stdin().lock(),
        &mut std::io::stdout().lock(),
    ) {
        Ok(()) => 0,
        Err(SealError::InvalidMaterial) => 2,
        Err(SealError::TpmAccessDenied) => 4,
        Err(SealError::SoftwareChoiceRequired) => 5,
        Err(_) => identity_seal::IDENTITY_UNSEALABLE_EXIT_CODE,
    }
}

fn execute(
    args: &[String],
    input: &mut impl Read,
    output: &mut impl Write,
) -> Result<(), SealError> {
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["create"] | ["create", "--backend", "software"] => {
            let backend = if args.len() == 3 {
                Backend::Software
            } else {
                identity_seal::probe()?
            };
            if args.len() != 3 && backend == Backend::Software {
                return Err(SealError::SoftwareChoiceRequired);
            }
            let (seal, custody) = identity_seal::create(backend)?;
            serde_json::to_writer(
                &mut *output,
                &serde_json::json!({
                    "backend": seal.backend,
                    "material": seal.material,
                    "public_key": URL_SAFE_NO_PAD.encode(custody.public_key()),
                    "p256_public_key": URL_SAFE_NO_PAD.encode(custody.p256_public_key()),
                }),
            )
            .map_err(|_| SealError::InvalidMaterial)?;
        }
        ["inspect"] => {
            let mut bytes = Zeroizing::new(Vec::new());
            input.take(12_289).read_to_end(&mut bytes)?;
            if bytes.len() > 12_288 {
                return Err(SealError::InvalidMaterial);
            }
            let seal: IdentitySealWire =
                serde_json::from_slice(&bytes).map_err(|_| SealError::InvalidMaterial)?;
            let custody = identity_seal::open(&seal)?;
            serde_json::to_writer(
                &mut *output,
                &serde_json::json!({
                    "public_key": URL_SAFE_NO_PAD.encode(custody.public_key()),
                    "p256_public_key": URL_SAFE_NO_PAD.encode(custody.p256_public_key()),
                }),
            )
            .map_err(|_| SealError::InvalidMaterial)?;
        }
        _ => return Err(SealError::InvalidMaterial),
    }
    output.write_all(b"\n")?;
    output.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_cli_shapes_roundtrip_without_secret_in_inspection() {
        let mut output = Vec::new();
        execute(
            &["create".into(), "--backend".into(), "software".into()],
            &mut &[][..],
            &mut output,
        )
        .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
        assert_eq!(value["backend"], "software");
        let input = serde_json::to_vec(
            &serde_json::json!({"backend": value["backend"], "material": value["material"]}),
        )
        .unwrap();
        let mut inspected = Vec::new();
        execute(&["inspect".into()], &mut input.as_slice(), &mut inspected).unwrap();
        let inspected: serde_json::Value = serde_json::from_slice(&inspected).unwrap();
        assert_eq!(inspected.as_object().unwrap().len(), 2);
        assert_eq!(inspected["public_key"], value["public_key"]);
        assert_eq!(inspected["p256_public_key"], value["p256_public_key"]);
        for refused in [["create", "--backend", "hardware"], ["create", "--backend", "none"]] {
            assert!(
                execute(
                    &refused.map(String::from),
                    &mut &[][..],
                    &mut Vec::new()
                )
                .is_err()
            );
        }
    }
}
