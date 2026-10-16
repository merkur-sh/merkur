/**
 * Merkur holds every secret it keeps in memory in `zeroize::Zeroizing`, which wipes the value when
 * it is dropped. The type is the marker these queries follow: no name or pattern decides what is
 * secret.
 */

import rust
private import codeql.rust.dataflow.DataFlow
private import codeql.rust.internal.typeinference.TypeInference as TypeInference
private import codeql.rust.internal.typeinference.Type

/** Holds if `e` is a `Zeroizing` value, or a reference to or container of one. */
predicate isZeroizing(Expr e) {
  TypeInference::inferType(e, _).(StructType).getTypeItem().(Addressable).getCanonicalPath() =
    "zeroize::Zeroizing"
}

/**
 * Holds if `succ` reads the secret `pred` holds: a reference to it, its dereference, an index
 * into it, or the result of a method called on it, which is how a slice of the wrapped bytes is
 * reached (`as_slice`, `as_ref`, `deref`).
 */
predicate readsSecret(DataFlow::Node pred, DataFlow::Node succ) {
  succ.asExpr().(RefExpr).getExpr() = pred.asExpr()
  or
  exists(PrefixExpr deref | deref.getOperatorName() = "*" |
    deref.getExpr() = pred.asExpr() and succ.asExpr() = deref
  )
  or
  succ.asExpr().(IndexExpr).getBase() = pred.asExpr()
  or
  exists(MethodCall call |
    call.getReceiver() = pred.asExpr() and isZeroizing(pred.asExpr()) and succ.asExpr() = call
  )
}

/** Holds if `e` is an owned buffer a copy can be made into. */
predicate isOwnedBuffer(Expr e) {
  TypeInference::inferType(e).(StructType).getTypeItem().(Addressable).getCanonicalPath() =
    [
      "alloc::vec::Vec", "alloc::string::String", "alloc::boxed::Box", "alloc::sync::Arc",
      "alloc::rc::Rc", "bytes::bytes::Bytes", "bytes::bytes_mut::BytesMut"
    ]
}

/** A length or emptiness test, which every value of one size answers alike. */
predicate isPublicMeasure(DataFlow::Node node) {
  node.asExpr().(MethodCall).getTargetName() = ["len", "is_empty"]
}
