"""
Main application routes.
"""
from flask import Blueprint, render_template, request

from findviz.routes.shared import data_manager

main_bp = Blueprint('main', __name__)

@main_bp.route('/')
def index():
    """Serve the main application page."""
    embed_mode = request.args.get('embed') == '1'
    return render_template(
        'index.html',
        embed_mode=embed_mode,
        patient_name=request.args.get('patient_name', ''),
        patient_email=request.args.get('patient_email', ''),
        return_url=request.args.get('return_url', ''),
    )

# display analysis view for a specific analysis route
@main_bp.route('/analysis_view/<analysis>')
def analysis_view(analysis):
    """Display the analysis view for a specific analysis."""
    if analysis == 'average':
        data_manager.switch_context('average')
    elif analysis == 'correlate':
        data_manager.switch_context('correlate')
    
    # get the plot type
    plot_type = data_manager.ctx.fmri_file_type

    return render_template(
        'analysis.html', 
        plot_type=plot_type,
        analysis=analysis,
        embed_mode=request.args.get('embed') == '1',
        patient_name=request.args.get('patient_name', ''),
        patient_email=request.args.get('patient_email', ''),
        return_url=request.args.get('return_url', ''),
    )
