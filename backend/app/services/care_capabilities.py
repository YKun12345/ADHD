"""Code compatibility only; availability and authority remain business checks."""
from backend.app.services.assessment_templates import templates,REGISTRY_SHA256


def response():
    frozen=templates()
    return {'contract_version':1,'submission_schema_versions':[1],'patient_record_envelope_versions':[2],
            'registry_digest':REGISTRY_SHA256,
            'protocols':[{'kind':kind,'protocol_id':protocol,'protocol_schema_version':version,
                          'platforms':['miniprogram','web'],'evidence_schema_version':2 if kind=='cognitive' else None,
                          'configurations':[{'age_group':template['age_group'],'instrument':item['instrument'],'config_digest':item['config_digest']}
                              for template in frozen for item in template['items'] if (item['kind'],item['protocol_id'],item['protocol_schema_version'])==(kind,protocol,version)]}
                         for kind,protocol,version in sorted({(item['kind'],item['protocol_id'],item['protocol_schema_version']) for template in frozen for item in template['items']})],
            'legacy_preview':{'protocol_id':'patient-web-preview-v1','formal_assessment_credit':False},
            'admission':{'engineering_templates_only':True,'real_patient_execution_approved':False},
            'policy':'Compatibility declarations do not grant patient access, model admission, professional approval or clinical acceptance.'}
