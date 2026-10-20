"""Read-only exact RDP composition in the isolated training environment."""
import json
import math
import sys


def compose(histories,*,delta=1e-5):
    from opacus.accountants import RDPAccountant
    accountant=RDPAccountant();total=0
    if not 0<delta<=1e-5:raise ValueError('Invalid overall delta')
    if not isinstance(histories,list) or len(histories)>10000:raise ValueError('RDP history must be bounded')
    for noise,rate,steps in histories:
        if not math.isfinite(noise) or noise<2 or not 0<rate<=1 or type(steps) is not int or not 0<=steps<=100000:raise ValueError('Invalid RDP mechanism')
        for _ in range(steps):accountant.step(noise_multiplier=noise,sample_rate=rate)
        total+=steps
    epsilon=accountant.get_epsilon(delta=delta) if total else 0.0
    if not math.isfinite(epsilon):raise ValueError('Invalid RDP result')
    return {'epsilon':epsilon,'delta':delta,'mechanism_steps':total,'accountant':'rdp','composition':'conservative_sequential'}


if __name__=='__main__':
    data=json.loads(sys.stdin.read(1024*1024));print(json.dumps(compose(data['histories'],delta=data.get('delta',1e-5))))
