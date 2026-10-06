"""Declared factory and original-probe source controls; no native TPM qualification."""
import ast
import importlib.util
import io
import tarfile
import tempfile
import unittest
from pathlib import Path

class Attr:
    def __getattr__(self, name):
        return lambda *args, **kwargs: (name,args,kwargs)

class Declarations(unittest.TestCase):
    def factory(self):
        calls=[]
        scope={'load':lambda *args:None,'attr':Attr(),'rule':lambda **kwargs:lambda **attrs:calls.append(('inputs',attrs)),'rust_common':type('Rust',(),{'crate_info':object()})(),'TestRuntimeInfo':object(),'DebianRootfsInfo':object(),'NatlabImageInfo':object(),'fail':lambda message:(_ for _ in ()).throw(ValueError(message)),'bun_command_test':lambda **kwargs:calls.append(('test',kwargs))}
        exec(compile(Path(__file__).with_name('tpm.bzl').read_text(),'tpm.bzl','exec'),scope)
        return scope['tpm_simulator_test'],calls

    def test_actual_native_factory_bindings_and_data_are_mandatory(self):
        factory,calls=self.factory()
        factory('tpm','//current:feature_lib','//runtime:image','//sdk:docker','unix:///owned/docker.sock',tags=['manual'])
        self.assertEqual([kind for kind,_ in calls],['inputs','test'])
        inputs=calls[0][1];test=calls[1][1]
        self.assertTrue(inputs['testonly'])
        self.assertEqual(inputs['harness'],'//current:feature_lib')
        self.assertEqual(test['tools'],{'//sdk:docker':'docker'})
        self.assertEqual(test['tool_environment'],{'docker':'MERKUR_TPM_DOCKER'})
        self.assertEqual(test['environment_files'],{':tpm_inputs':'MERKUR_TPM_INPUTS'})
        self.assertIn('//scripts:test-tpm-sim.ts',test['data'])
        self.assertIn('//tools/bazel/verification:real-helper.ts',test['data'])
        self.assertIn('//tools/bazel/bun:owned-files.ts',test['data'])
        self.assertEqual(test['tags'],['manual'])
        with self.assertRaises(TypeError):factory('tpm')

    def test_no_implicit_or_remote_docker_socket(self):
        for endpoint in ['','tcp://remote:2375','unix://relative']:
            factory,calls=self.factory()
            with self.assertRaises(ValueError):factory('tpm','harness','image','docker',endpoint)
            self.assertEqual(calls,[])

    def test_image_consumer_cannot_choose_or_drop_required_utilities(self):
        spec=importlib.util.spec_from_file_location('image',Path(__file__).parent/'natlab/image.py');image=importlib.util.module_from_spec(spec);spec.loader.exec_module(image)
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'rootfs.tar'
            with tarfile.open(source,'w') as archive:
                tmp=tarfile.TarInfo('tmp');tmp.type=tarfile.DIRTYPE;tmp.mode=0o1777;archive.addfile(tmp)
                executable=tarfile.TarInfo('usr/bin/swtpm');executable.mode=0o755;executable.size=1;archive.addfile(executable,io.BytesIO(b'x'))
            image.validate_rootfs(source,'tpm')
            with self.assertRaises(ValueError):image.validate_rootfs(source,'natlab')
            with self.assertRaises(ValueError):image.validate_rootfs(source,'custom')
            with self.assertRaises(TypeError):image.validate_rootfs(source,required=())

if __name__=='__main__':unittest.main()
