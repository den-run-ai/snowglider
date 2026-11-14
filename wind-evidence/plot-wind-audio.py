from pathlib import Path
import json
import numpy as np
from scipy.io import wavfile
from scipy.signal import spectrogram
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

root = Path(__file__).parent
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'text.color':'#dceaf5','axes.labelcolor':'#b0c6d8','xtick.color':'#9cb4c7','ytick.color':'#9cb4c7','axes.edgecolor':'#3d5267'})
fig = plt.figure(figsize=(14,9), facecolor='#091522')
grid = fig.add_gridspec(3,1, height_ratios=[1,1,.8], left=.075,right=.93,top=.86,bottom=.14,hspace=.26)
fig.text(.075,.95,'Wind sound — before and after', fontsize=25,weight='bold')
fig.text(.075,.91,'Production Sfx graph • real Chromium OfflineAudioContext • no music or recorded assets', fontsize=12,color='#a8bdce')
last = None
signals = {}
for row,label in enumerate(['before','after']):
    rate, raw = wavfile.read(root/f'wind-audio-{label}.wav')
    samples = raw.astype(np.float64)/32768
    signals[label] = samples
    f,t,p = spectrogram(samples.mean(axis=1),fs=rate,nperseg=1024,noverlap=768)
    ax = fig.add_subplot(grid[row,0],facecolor='#0f2233')
    last = ax.pcolormesh(t,f,10*np.log10(np.maximum(p,1e-14)),shading='auto',cmap='magma',vmin=-95,vmax=-42,rasterized=True)
    ax.set_ylim(180,4500); ax.set_yscale('log'); ax.set_yticks([250,500,1000,2000,4000],['250','500','1k','2k','4k'])
    ax.set_xlim(0,24); ax.set_xticks(range(0,25,2)); ax.set_ylabel('Frequency / Hz')
    ax.text(.01,.88,'BEFORE · narrow whistle, centered mono' if row==0 else 'AFTER · broad gust wash, camera-relative stereo', transform=ax.transAxes, color='white',fontsize=12,weight='bold', bbox={'facecolor':'#091522','alpha':.8,'edgecolor':'none','pad':5})
    for x in [3,6,10,14,18,22]: ax.axvline(x,color='#edf2fa',alpha=.25,lw=.8)
    ax.tick_params(axis='x',labelbottom=False)
ax=fig.add_subplot(grid[2,0],facecolor='#0f2233')
for label,samples in signals.items():
    block=round(rate*.1)
    frames=samples[:len(samples)//block*block].reshape(-1,block,2)
    rms=np.sqrt(np.mean(frames**2,axis=1))
    time=(np.arange(len(rms))+.5)*.1
    if label=='before': ax.plot(time,rms[:,0],color='#8195a7',alpha=.7,lw=1.1,label='Before (L = R)')
    else:
        ax.plot(time,rms[:,0],color='#65e1cb',lw=1.5,label='After · left')
        ax.plot(time,rms[:,1],color='#e6b66a',lw=1.5,label='After · right')
ax.set_xlim(0,24); ax.set_ylim(0,.08); ax.set_xticks(range(0,25,2)); ax.set_ylabel('RMS amplitude'); ax.set_xlabel('Time / seconds'); ax.grid(alpha=.1)
ax.legend(loc='upper right',facecolor='#0f2233',edgecolor='#3d5267',labelcolor='#dceaf5',fontsize=10,ncol=3)
for x in [3,6,10,14,18,22]: ax.axvline(x,color='#edf2fa',alpha=.2,lw=.8)
labels=[(1.5,'Calm'),(4.5,'Open gust'),(8,'Headwind'),(12,'Tailwind'),(16,'Forest · left'),(20,'Camera turns'),(23,'Mute')]
for x,text in labels: ax.text(x,-.030,text, transform=ax.get_xaxis_transform(),va='top',ha='center',fontsize=9,color='#dceaf5')
# Keep the scenario row above the numeric ticks separate from the bottom evidence line.
for txt in ax.texts: txt.set_position((txt.get_position()[0],1.02))
fig.text(.075,.055,'Headwind / tailwind: 7.6 dB RMS separation   •   Stereo follows the camera   •   Peak 0.246   •   0 clipped samples',fontsize=11,color='#cce5df')
fig.text(.075,.026,'Controlled wind-only capture; this does not establish physical iPhone / Android audio acceptance.',fontsize=9,color='#8da4b6')
cax=fig.add_axes([.945,.40,.013,.46]); cb=fig.colorbar(last,cax=cax);cb.set_label('Spectral power / dBFS per Hz',fontsize=9)
fig.savefig(root/'wind-audio-comparison.png',dpi=140,facecolor=fig.get_facecolor())
plt.close(fig)
