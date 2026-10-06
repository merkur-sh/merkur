"""Pure original TPM selector controls for the existing native helper insertion."""
import importlib.util
import os
import sys
import copy
from pathlib import Path
import tempfile
import tomllib
import unittest

runfiles = os.environ.get("TEST_SRCDIR")
workspace = os.environ.get("TEST_WORKSPACE")
if runfiles is None or workspace is None or not Path(runfiles).is_absolute() or workspace in ("", ".", "..") or "/" in workspace:
    raise ValueError("Original TPM recipe controls require the declared source runfiles namespace")
source_root = Path(runfiles) / workspace
helper = source_root / "tools/bazel/rust/native_protocol_generate.py"
specification = importlib.util.spec_from_file_location("declared_native_helper", helper)
if specification is None or specification.loader is None:
    raise ValueError("Missing declared native helper File")
module = importlib.util.module_from_spec(specification)
specification.loader.exec_module(module)
scope = vars(module)

class TpmRecipeControls(unittest.TestCase):
    def setUp(self):
        self.private=tempfile.TemporaryDirectory(prefix='tpm recipe source ');self.addCleanup(self.private.cleanup);self.root=Path(self.private.name)
        for name in ['scripts/test-tpm-sim.ts','packages/merkur-identity-seal/Cargo.toml']:
            file=self.root/name;file.parent.mkdir(parents=True,exist_ok=True);file.write_bytes((source_root/name).read_bytes())
        self.host='aarch64-apple-darwin'
        unit={'pkg_id':scope['TPM_IDENTITY'],'target':{'kind':['lib'],'src_path':scope['TPM_SOURCE']},'mode':'test','features':['tpm-sim'],'platform':None,'profile':{'name':'test'}}
        self.graph={'execution_host':self.host,'roots':[0,1],'units':[unit,{**copy.deepcopy(unit),'mode':'doctest'}]}
    def test_exact_original_literal_command_and_current_feature_manifest(self):
        self.assertEqual(scope['tpm_recipe'](self.root),['cargo','test','-p','merkur-identity-seal','--locked','--features','tpm-sim','--','tpm_sim'])
    def test_changed_original_package_feature_profile_or_filter_refuses(self):
        file=self.root/'scripts/test-tpm-sim.ts';original=file.read_text()
        for before,after in [("'merkur-identity-seal'","'other'"),("'tpm-sim'","'default'"),("'--locked'","'--release'"),("'tpm_sim'","'reduced'")]:
            file.write_text(original.replace(before,after))
            with self.assertRaises(ValueError):scope['tpm_recipe'](self.root)
    def test_changed_original_optional_dependency_feature_refuses(self):
        file=self.root/'packages/merkur-identity-seal/Cargo.toml';file.write_text(file.read_text().replace('tpm-sim = ["dep:tpm2-protocol"]','tpm-sim = []'))
        with self.assertRaises(ValueError):scope['tpm_recipe'](self.root)
    def test_exact_native_library_and_original_doctest_roots(self):
        self.assertEqual(scope['tpm_harnesses'](self.graph,self.host),0)
        self.assertEqual([self.graph['units'][i]['mode'] for i in self.graph['roots']],['test','doctest'])
    def test_missing_doc_no_feature_build_release_and_foreign_source_refuse(self):
        for field,value in [('features',[]),('mode','build'),('profile',{'name':'release'}),('target',{'kind':['lib'],'src_path':'foreign/lib.rs'}),('platform','wasm32-unknown-unknown')]:
            graph=copy.deepcopy(self.graph);graph['units'][0][field]=value
            with self.assertRaises(ValueError):scope['tpm_harnesses'](graph,self.host)
        graph=copy.deepcopy(self.graph);graph['roots']=[0]
        with self.assertRaises(ValueError):scope['tpm_harnesses'](graph,self.host)
    def test_foreign_host_invalid_or_duplicated_indexes_refuse(self):
        for roots in [[0,0],[True],[-1],[100],[]]:
            graph=copy.deepcopy(self.graph);graph['roots']=roots
            with self.assertRaises(ValueError):scope['tpm_harnesses'](graph,self.host)
        self.graph['execution_host']='x86_64-unknown-linux-gnu'
        with self.assertRaises(ValueError):scope['tpm_harnesses'](self.graph,self.host)

if __name__=='__main__':unittest.main(argv=[__file__])
